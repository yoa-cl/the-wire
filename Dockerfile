# The Wire — production image.
#
# This fork already contains the decoupled scheduler and the staggered audience
# refresh, so there is no build-time patching of the source. If you are adapting
# an older Dockerfile that used `sed` to rewrite intervals or strip the Audience
# tab, delete those lines: they will fail the build, and the Audience tab is now
# where the manual-entry and staggered-refresh features live.

FROM node:24-alpine

WORKDIR /app

# Dependencies first, so this layer stays cached until the lockfile changes.
# Dev dependencies are required here: `next build` needs TypeScript.
COPY package.json package-lock.json ./
RUN npm ci

# Then the application source. A code edit rebuilds from this point, not from
# `npm ci`, which keeps rebuilds to a few seconds.
COPY . .
RUN npm run build

ENV NODE_ENV=production
# The scheduler builds its own loopback URL from PORT; keep it in step with the
# port passed to `next start` below.
ENV PORT=3000

EXPOSE 3000

# 0.0.0.0 binds every interface *inside the container* only. The published port
# in compose.yaml is bound to 127.0.0.1 on the host, so nothing is exposed to
# the network. See docs/DEPLOYMENT.md for why both halves matter.
CMD ["npx", "next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
