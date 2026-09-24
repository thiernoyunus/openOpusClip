FROM node:22-alpine

WORKDIR /app

COPY dashboard/package.json dashboard/package-lock.json* ./

RUN npm install

COPY dashboard/ .
COPY remotion/src /remotion/src

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host"]
