FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends bash ca-certificates curl git python3 ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

ENV HOME=/home/node
WORKDIR /workspace
USER node

CMD ["node", "--version"]
