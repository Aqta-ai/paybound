FROM node:24-bookworm

WORKDIR /home/node/demo
RUN chown node:node .
USER node

COPY --chown=node:node package.json package-lock.json ./
# The lockfile pins the public forge-std repository with an SSH URL.
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/ \
    && npm ci --no-audit --no-fund

COPY --chown=node:node hardhat.config.ts remappings.txt tsconfig.json ./
COPY --chown=node:node contracts ./contracts
RUN npm run build

COPY --chown=node:node agent ./agent
COPY --chown=node:node sdk ./sdk
COPY --chown=node:node demo ./demo

CMD ["npm", "run", "stage", "--", "--no-open"]
