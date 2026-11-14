# syntax=docker/dockerfile:1
# 多架构：docker buildx build --platform linux/amd64,linux/arm64 .
# 网页、插件、Go 都在构建机原生架构上跑（Go 交叉编译），目标架构阶段没有 RUN，不需要 QEMU。

FROM --platform=$BUILDPLATFORM node:24-alpine AS node
WORKDIR /src
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY extension/package.json extension/package-lock.json extension/
RUN cd extension && npm ci
COPY web/ web/
RUN cd web && npm run build
COPY extension/ extension/
RUN cd extension && npm run build && npm run package

FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS go
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
ARG COMMIT=unknown
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY --from=node /src/web/dist/ internal/webui/dist/
COPY --from=node /src/extension/dist/shelfmark-chrome.zip /src/extension/dist/shelfmark-firefox.zip internal/webui/dist/downloads/
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath \
      -ldflags "-s -w -X shelfmark/internal/config.Version=${VERSION} -X shelfmark/internal/config.Commit=${COMMIT}" \
      -o /out/shelfmark ./cmd/shelfmark \
 && mkdir -p /out/data

FROM gcr.io/distroless/static:nonroot
COPY --from=go /out/shelfmark /usr/local/bin/shelfmark
COPY --from=go --chown=65532:65532 /out/data /data
ENV SHELFMARK_LISTEN=:8080 \
    SHELFMARK_DATA_DIR=/data
USER 65532:65532
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/shelfmark", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/shelfmark"]
CMD ["serve"]
