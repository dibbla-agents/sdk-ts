# The conformance profile worker on the SDK as published: the packed tarball,
# installed like any user's dependency. Built by devtest/bundle.sh.
FROM node:22-slim
WORKDIR /app
COPY package.json dibbla-agents-sdk-ts.tgz ./
RUN npm install --omit=dev --no-audit --no-fund ./dibbla-agents-sdk-ts.tgz tsx@4
COPY worker.ts entry.ts ./
# Resolved from inside /app, so Node applies the package's exports map (ESM build).
RUN printf "export * from '@dibbla-agents/sdk-ts';\n" > load.mjs
ENV CONFORMANCE_SDK_LOADER=/app/load.mjs
EXPOSE 80
CMD ["node", "--import", "tsx", "entry.ts"]
