/**
 * The process's drain (D221). Kubernetes runs the backend's `preStop` hook
 * before it stops the pod: the hook sends SIGUSR2 and pauses 10 s, so that
 * Traefik stops sending the pod new requests before it stops accepting them.
 * From SIGUSR2 on, both listeners keep serving, and an answer asks its client
 * to close the connection, `Connection: close` - the receiver's own reply to a
 * webhook included, which is written outside Fastify (`sendWebhookResponse`) -
 * so that no connection kept alive is left to carry a request to a process
 * about to stop. SIGTERM drains too, before it closes the listeners
 * (`lifecycle.ts`).
 *
 * Only the answer to a socket's sole request in flight closes the connection.
 * A client may pipeline requests on one connection - the receive host passes
 * a sender's bytes through to Node (D187) - and Node writes the answers in
 * order: an answer that ends the connection while another request of the
 * same socket waits behind it would leave that request unanswered, its
 * webhook stored but its sender never told. So the answer keeps the
 * connection alive while the socket has more than one request in flight.
 * That is read when the answer's head is written (`closes`), and a request
 * counts as in flight from its arrival until its response's `close`: an
 * answer closes the connection only when no other request of its socket is
 * in flight at that moment, ahead of it or behind it. As a rule that is the
 * pipeline's last answer; but when a pipelined pair's first answer is held -
 * a configured delay - and the second's head is written first, both go out
 * keep-alive, and the connection closes on its next answer or at SIGTERM.
 * Nothing is lost or refused. What stays open is a request whose bytes
 * arrive between the closing answer's head and its end; RFC 9112 asks
 * clients not to pipeline after a request that is not idempotent anyway.
 *
 * An HTTP/2 connection of the receive listener (D263) has no
 * `Connection: close`: from the drain on, each of its sessions is sent a
 * GOAWAY with `NO_ERROR` once, naming the last stream it has taken - at the
 * start of the drain for a session open then, and on its next stream for one
 * that opens later, which is served - so that its client opens no stream on
 * it any more, while every stream it has already opened is answered. SIGTERM
 * then closes what is left (`buildReceiver`).
 */
import type { Server } from 'node:http';
import { constants, type Http2Server, type ServerHttp2Session } from 'node:http2';
import type { Socket } from 'node:net';

export class Drain {
  #draining = false;
  /** Requests in flight on each socket, from their arrival to their response's close. */
  readonly #inFlight = new WeakMap<Socket, number>();
  /** The open HTTP/2 sessions of each server tracked, each set kept by the server's owner. */
  readonly #http2Sessions: ReadonlySet<ServerHttp2Session>[] = [];
  /** The sessions sent their GOAWAY. */
  readonly #goneAway = new WeakSet<ServerHttp2Session>();

  /** Whether the process is draining. */
  get draining(): boolean {
    return this.#draining;
  }

  /** Starts draining; draining again changes nothing. */
  start(): void {
    this.#draining = true;

    for (const sessions of this.#http2Sessions) {
      for (const session of sessions) {
        this.#goAway(session);
      }
    }
  }

  /**
   * Sends the GOAWAY once the drain has started to every session of
   * `sessions`, the open sessions of `server` as its owner keeps them
   * (`installHttp2`), and to a session that opens a stream later (D263).
   */
  trackHttp2(server: Http2Server, sessions: ReadonlySet<ServerHttp2Session>): void {
    this.#http2Sessions.push(sessions);
    server.on('stream', (stream) => {
      if (this.#draining) {
        this.#goAway(stream.session as ServerHttp2Session);
      }
    });
  }

  /**
   * A GOAWAY with `NO_ERROR`, once a session, naming the last stream it has
   * taken: the streams it has opened are answered, and its client opens no
   * more on it.
   */
  #goAway(session: ServerHttp2Session | undefined): void {
    if (
      session === undefined ||
      session.closed ||
      session.destroyed ||
      this.#goneAway.has(session)
    ) {
      return;
    }

    this.#goneAway.add(session);
    session.goaway(constants.NGHTTP2_NO_ERROR);
  }

  /** Counts the requests `server` has in flight on each of its sockets. */
  track(server: Server): void {
    server.on('request', (request, response) => {
      const socket = request.socket;

      this.#inFlight.set(socket, (this.#inFlight.get(socket) ?? 0) + 1);
      response.once('close', () => {
        const left = (this.#inFlight.get(socket) ?? 1) - 1;

        if (left > 0) {
          this.#inFlight.set(socket, left);
        } else {
          this.#inFlight.delete(socket);
        }
      });
    });
  }

  /**
   * Whether an answer written now on `socket` ends its connection: the
   * process is draining, and no other request of the socket is in flight.
   */
  closes(socket: Socket | null | undefined): boolean {
    return this.#draining && socket != null && (this.#inFlight.get(socket) ?? 0) <= 1;
  }

  /** Requests in flight on `socket`. Exists for tests and diagnostics. */
  inFlight(socket: Socket): number {
    return this.#inFlight.get(socket) ?? 0;
  }
}
