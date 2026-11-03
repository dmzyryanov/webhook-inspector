{{- define "qa-tools.name" -}}
{{- .Release.Name -}}
{{- end -}}

{{- define "qa-tools.labels" -}}
app.kubernetes.io/name: {{ include "qa-tools.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/*
The image tag, and the registry checked with it: neither has a default, so an
install names its own images (D022, #367).
*/}}
{{- define "qa-tools.imageTag" -}}
{{- if not .Values.images.registry -}}
{{- fail "images.registry must be set to the registry and path holding the images (README.md)" -}}
{{- end -}}
{{- required "images.tag must be set to the commit SHA being deployed (D022)" .Values.images.tag -}}
{{- end -}}

{{/*
The two hosts every install names (#367): the site's and the receive host's.
Either missing refuses the render, naming both values.
*/}}
{{- define "qa-tools.hostsRequired" -}}
{{- if not (and .Values.ingress.host .Values.receive.host) -}}
{{- fail "ingress.host and receive.host must both be set: the site's host and the receive host (README.md)" -}}
{{- end -}}
{{- end -}}

{{- define "qa-tools.host" -}}
{{- include "qa-tools.hostsRequired" . -}}
{{- .Values.ingress.host -}}
{{- end -}}

{{- define "qa-tools.receiveHost" -}}
{{- include "qa-tools.hostsRequired" . -}}
{{- .Values.receive.host -}}
{{- end -}}

{{/*
Secret names: the value when set, otherwise one derived from the release.
*/}}
{{- define "qa-tools.tlsSecret" -}}
{{- .Values.ingress.tls.secretName | default (printf "%s-tls" (include "qa-tools.name" .)) -}}
{{- end -}}

{{- define "qa-tools.aliasTlsSecret" -}}
{{- .Values.ingress.tls.aliasSecretName | default (printf "%s-alias-tls" (include "qa-tools.name" .)) -}}
{{- end -}}

{{- define "qa-tools.receiveTlsSecret" -}}
{{- .Values.receive.tlsSecretName | default (printf "%s-receive-tls" (include "qa-tools.name" .)) -}}
{{- end -}}

{{- define "qa-tools.postgresSecret" -}}
{{- .Values.postgres.existingSecret | default (printf "%s-postgres" (include "qa-tools.name" .)) -}}
{{- end -}}

{{- define "qa-tools.offsiteSecret" -}}
{{- .Values.backup.offsite.existingSecret | default (printf "%s-offsite-backup" (include "qa-tools.name" .)) -}}
{{- end -}}

{{- define "qa-tools.heartbeatSecret" -}}
{{- .Values.alerts.existingSecret | default (printf "%s-heartbeat" (include "qa-tools.name" .)) -}}
{{- end -}}

{{/*
The site the monitor probes: alerts.siteUrl, or the site's own origin.
*/}}
{{- define "qa-tools.siteUrl" -}}
{{- .Values.alerts.siteUrl | default (printf "https://%s" (include "qa-tools.host" .)) -}}
{{- end -}}

{{- define "qa-tools.postgresHost" -}}
{{ include "qa-tools.name" . }}-postgres
{{- end -}}

{{/*
The backend receives one connection string, composed here from the password in
the secret. Kubernetes expands $(VAR) among a container's own environment
variables, so the password itself never appears in the manifest or in the Helm
release.
*/}}
{{- define "qa-tools.databaseUrl" -}}
postgres://{{ .Values.postgres.user }}:$(POSTGRES_PASSWORD)@{{ include "qa-tools.postgresHost" . }}:{{ .Values.postgres.port }}/{{ .Values.postgres.database }}
{{- end -}}
