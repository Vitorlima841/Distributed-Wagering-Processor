FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 3000
# migrations antes de subir; o papel vem de ROLE
CMD ["sh", "-c", "bun scripts/migrate.ts up && bun src/main.ts"]
