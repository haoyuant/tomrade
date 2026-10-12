# The Linux runner (setup.sh linux): an x64 container that Docker Desktop
# runs under Rosetta. Ubuntu 22.04 like the hosted image it replaces, so the
# AppImage still runs on older glibc. Node comes from setup-node; this adds
# what the jobs call besides it.
FROM ubuntu:22.04

ARG RUNNER_VERSION
ARG RUNNER_SHA256
ARG YQ_VERSION=v4.54.1
ARG YQ_SHA256=8e34fc298390875de416e6a4afcb8cabeceb25d9aa8506c1a2f9353cf702ea5f

ENV DEBIAN_FRONTEND=noninteractive
# g++/make/python3: electron-rebuild compiles better-sqlite3 on install.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq sudo unzip xz-utils zip python3 make g++ \
 && install -d -m 755 /etc/apt/keyrings \
 && curl -fsSL -o /etc/apt/keyrings/githubcli.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64" \
 && echo "${YQ_SHA256}  /usr/local/bin/yq" | sha256sum -c - \
 && chmod +x /usr/local/bin/yq

RUN useradd -m runner && echo "runner ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/runner
WORKDIR /home/runner/actions-runner
RUN curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
 && echo "${RUNNER_SHA256}  runner.tar.gz" | sha256sum -c - \
 && tar xzf runner.tar.gz && rm runner.tar.gz \
 && ./bin/installdependencies.sh && rm -rf /var/lib/apt/lists/* \
 && chown -R runner:runner /home/runner

COPY --chmod=755 linux-entrypoint.sh /usr/local/bin/entrypoint
USER runner
ENTRYPOINT ["entrypoint"]
