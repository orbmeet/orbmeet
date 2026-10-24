FROM golang:1.26-alpine@sha256:ce864e7223ac17b1775e6fd0b4c0db580c2eb50e7953a427916379e4b92a1628 AS build
RUN apk add --no-cache git ca-certificates
RUN go install github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.5
ENV CGO_ENABLED=0
RUN xcaddy build v2.11.4 --output /caddy --with github.com/mholt/caddy-l4@v0.1.1

FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
RUN apk add --no-cache ca-certificates libcap tzdata && \
    addgroup -g 10000 caddy && adduser -D -u 10000 -G caddy caddy && \
    mkdir /data /config && chown caddy:caddy /data /config
COPY --from=build /caddy /usr/bin/caddy
RUN setcap cap_net_bind_service=+ep /usr/bin/caddy
USER caddy
ENV XDG_DATA_HOME=/data XDG_CONFIG_HOME=/config
ENTRYPOINT ["caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
