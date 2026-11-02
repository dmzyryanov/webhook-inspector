{{- define "qa-tools.name" -}}
{{- .Release.Name -}}
{{- end -}}

{{- define "qa-tools.labels" -}}
app.kubernetes.io/name: {{ include "qa-tools.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "qa-tools.imageTag" -}}
{{- required "images.tag must be set to the commit SHA being deployed (D022)" .Values.images.tag -}}
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
