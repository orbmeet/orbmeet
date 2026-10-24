# The toolchain image for whiteboard code cells.
#
# Every base below is pinned by digest as well as tag. This image is the sandbox
# boundary itself: everything untrusted that runs here runs inside it, so what
# it contains is a security property, and a tag is something its publisher may
# move. The tags stay for readability; the digests are what get pulled.

# The JavaScript and TypeScript runtime, copied as a single binary from its
# official image rather than installed: the active LTS line of Node, which runs
# TypeScript by stripping its types.
FROM docker.io/library/node:24.22.1-trixie-slim@sha256:fdc9220097e0ae3bd947c44b10cd3af5867a67a6d3a23b30b30b70929219034e AS node

FROM docker.io/library/debian:trixie-20260918-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

COPY --from=node /usr/local/bin/node /usr/local/bin/node

ENV DEBIAN_FRONTEND=noninteractive

# `--no-install-recommends` is load-bearing: the JDK's recommends pull in fonts,
# X libraries and documentation that a headless single-file compile never reads,
# and roughly double this layer.
#
# curl and ca-certificates fetch Go and Rust below. tini is PID 1, so that a
# process outliving a cellrun that was itself killed is still reaped.
RUN apt-get update && apt-get install -y --no-install-recommends \
		ca-certificates \
		curl \
		tini \
		python3 \
		gcc \
		g++ \
		libc6-dev \
		openjdk-21-jdk-headless \
	&& rm -rf /var/lib/apt/lists/*

# Downloads are checked against the digest their publisher lists, pinned here
# next to the version, as the base images are pinned above: a release is
# something its publisher, or anyone between, could still replace.
# Go: https://go.dev/dl/?mode=json
ARG GO_VERSION=1.27.1
ARG GO_SHA256=63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tar.gz \
	&& echo "${GO_SHA256}  /tmp/go.tar.gz" | sha256sum -c - \
	&& tar -C /usr/local -xzf /tmp/go.tar.gz \
	&& rm /tmp/go.tar.gz \
	&& rm -rf /usr/local/go/test /usr/local/go/api /usr/local/go/doc
ENV PATH="/usr/local/go/bin:${PATH}"

# `--profile minimal` is rustc, cargo and the std library and nothing else: no
# docs, no source, no clippy. It is the difference between roughly 700 MB and
# well over a gigabyte, and a single-file `rustc` invocation uses none of it.
#
# rustup-init itself, at a pinned rustup release, rather than the sh.rustup.rs
# script that fetches whichever one is current; rustup then checks every
# toolchain component against the release channel's manifest.
# https://static.rust-lang.org/rustup/archive/<version>/x86_64-unknown-linux-gnu/rustup-init.sha256
ARG RUST_VERSION=1.98.1
ARG RUSTUP_VERSION=1.29.1
ARG RUSTUP_INIT_SHA256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
ENV RUSTUP_HOME=/usr/local/rustup \
	CARGO_HOME=/usr/local/cargo \
	PATH="/usr/local/cargo/bin:${PATH}"
RUN curl -fsSL "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
		-o /tmp/rustup-init \
	&& echo "${RUSTUP_INIT_SHA256}  /tmp/rustup-init" | sha256sum -c - \
	&& chmod +x /tmp/rustup-init \
	&& /tmp/rustup-init -y \
		--profile minimal \
		--default-toolchain "${RUST_VERSION}" \
		--no-modify-path \
	&& rm /tmp/rustup-init \
	&& rm -rf "${RUSTUP_HOME}/toolchains"/*/share/doc \
	&& chmod -R a+rX "${RUSTUP_HOME}" "${CARGO_HOME}"

# One unprivileged user per slot: a board runs at most CELLRUN_SLOTS cells at
# once, and giving each slot its own uid is what keeps concurrent runs from
# reading, signalling or tracing each other. cellrun derives the uid from the
# slot number, so these two ARGs are the only place either is stated. The
# directories it works in, /cells and /run/cellrun, it creates and checks at
# run time: a runtime may mount over the image's (Cloudflare's replaces /run).
ARG CELLRUN_SLOTS=3
ARG CELLRUN_UID_BASE=2000
RUN for slot in $(seq 0 $((CELLRUN_SLOTS - 1))); do \
		uid=$((CELLRUN_UID_BASE + slot)); \
		groupadd --gid "$uid" "cell$slot" \
		&& useradd --uid "$uid" --gid "$uid" --no-create-home --home-dir /nonexistent \
			--shell /usr/sbin/nologin "cell$slot" || exit 1; \
	done

COPY cellrun.c /tmp/cellrun.c
RUN gcc -O2 -Wall -Wextra -Werror \
		-DCELLRUN_SLOTS="${CELLRUN_SLOTS}" -DCELLRUN_UID_BASE="${CELLRUN_UID_BASE}" \
		-o /usr/local/bin/cellrun /tmp/cellrun.c \
	&& rm /tmp/cellrun.c \
	&& chmod 0755 /usr/local/bin/cellrun

# Go's whole standard library, compiled once here. A cold `net/http` build takes
# about a minute on the half vCPU a board gets, three times the compile budget;
# from this cache it takes about a second. cellrun copies the template into each
# Go run, because the go command must be able to write to its cache even to
# read from it; the template itself is immutable and shared by no one's writes.
RUN GOCACHE=/var/cache/cellrun/go-build GOTOOLCHAIN=local GOTELEMETRY=off go build std \
	&& chown -R root:root /var/cache/cellrun \
	&& chmod -R a+rX,a-w /var/cache/cellrun

# Nothing in the image may be writable by everyone. A slot's uid owns only its
# own run directory, so with no world-writable path left, file permissions
# alone confine where a run can write — which is all there is on a kernel
# without Landlock, such as Cloudflare's. Mounts the runtime adds at start
# (/tmp, /dev/shm) are closed by cellrun itself; this covers the image, and
# fails the build if anything is missed.
RUN find / -xdev -perm -0002 ! -type l ! -type c -exec chmod o-w {} + \
	&& if find / -xdev -perm -0002 ! -type l ! -type c | grep -q .; then \
		echo "world-writable paths remain" >&2; exit 1; \
	fi

# Nothing runs in the container but its PID 1: the Durable Object starts each
# run with the container API's `exec()`, so there is no server in here and
# nothing listening on any port.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
