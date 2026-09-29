FROM node@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f
WORKDIR /opt/idou
COPY package.json ./
COPY manifest.js archive.js runtime-frames.js runtime-worker.js ./src/apps/
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/node", "--max-old-space-size=128", "/opt/idou/src/apps/runtime-worker.js"]
