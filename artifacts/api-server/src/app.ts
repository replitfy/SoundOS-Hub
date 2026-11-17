import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";

const app: Express = express();
// Replit serves the app behind its routing proxy. Trust the nearest proxy so
// req.ip identifies the original visitor instead of collapsing all public form
// submissions into the proxy's address.
app.set("trust proxy", 1);

// Runtime idempotent migration: ensure conversations.pessoa_id FK column exists
pool.query(
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pessoa_id INTEGER REFERENCES pessoas(id)`
).catch((err: unknown) => {
  logger.warn({ err }, "Migration: conversations.pessoa_id already exists or failed");
});

// Public factual exchanges may happen before a conversation is linked to a
// pessoa; conversation_id remains the mandatory audit anchor.
pool.query(
  `ALTER TABLE sofia_decision_runs ALTER COLUMN pessoa_id DROP NOT NULL`
).catch((err: unknown) => {
  logger.warn({ err }, "Migration: allow anonymous Sofia decision audit failed");
});

// Backfill idempotente: vídeos importados antes do campo `codigo` existir (ou
// criados sem um) nunca devem ficar com código em branco na listagem/CRUD.
pool.query(
  `UPDATE videos SET codigo = 'VID-' || lpad(id::text, 4, '0') WHERE codigo IS NULL OR btrim(codigo) = ''`
).catch((err: unknown) => {
  logger.warn({ err }, "Migration: backfill de videos.codigo falhou");
});

// Normalize legacy English status values to Portuguese canonical values.
pool.query(
  `UPDATE classes SET status = 'Planejada' WHERE status = 'scheduled'`
).catch((err: unknown) => {
  logger.warn({ err }, "Migration: normalize classes.status 'scheduled' failed");
});

// Align the column default with the canonical status vocabulary.
pool.query(
  `ALTER TABLE classes ALTER COLUMN status SET DEFAULT 'Planejada'`
).catch((err: unknown) => {
  logger.warn({ err }, "Migration: update classes.status default failed");
});

// Education referential integrity: add FK constraints if not already present.
// Using DO blocks so the migration is safe to run repeatedly.
// O aluno é uma `pessoa` (migration 014); a tabela `students` não existe mais.
pool.query(`
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_classes_course_id') THEN
      ALTER TABLE classes ADD CONSTRAINT fk_classes_course_id
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_enrollments_pessoa_id')
       AND EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'enrollments' AND column_name = 'pessoa_id') THEN
      ALTER TABLE enrollments ADD CONSTRAINT fk_enrollments_pessoa_id
        FOREIGN KEY (pessoa_id) REFERENCES pessoas(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_enrollments_class_id') THEN
      ALTER TABLE enrollments ADD CONSTRAINT fk_enrollments_class_id
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT;
    END IF;
  END
  $$;
`).catch((err: unknown) => {
  logger.warn({ err }, "Migration: education FK constraints failed — data may have invalid references");
});

// Colunas aditivas das migrations 011/013, repetidas aqui para que um ambiente
// que ainda não rodou os arquivos SQL se conserte sozinho no boot. O backfill e
// a remoção da tabela `students` (014) NÃO são feitos aqui de propósito: são
// destrutivos e devem ser aplicados conscientemente via scripts/migrations.
pool.query(
  `ALTER TABLE pessoa_servicos ADD COLUMN IF NOT EXISTS cursos_inscricao_id INTEGER
     REFERENCES cursos_inscricao(id) ON DELETE SET NULL`
).catch((err: unknown) => {
  logger.warn({ err }, "Migration: pessoa_servicos.cursos_inscricao_id falhou");
});

pool.query(
  `ALTER TABLE cursos_inscricao ADD COLUMN IF NOT EXISTS class_id INTEGER
     REFERENCES classes(id) ON DELETE SET NULL`
).catch((err: unknown) => {
  logger.warn({ err }, "Migration: cursos_inscricao.class_id falhou");
});

pool.query(
  `CREATE UNIQUE INDEX IF NOT EXISTS cursos_inscricao_class_id_unique
     ON cursos_inscricao (class_id) WHERE class_id IS NOT NULL`
).catch((err: unknown) => {
  logger.warn({ err }, "Migration: índice único cursos_inscricao.class_id falhou");
});

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          // Bearer link tokens must never appear in application request logs.
          url: req.url?.split("?")[0]?.replace(/(\/public\/formalizacao\/)[^/]+/g, "$1[REDACTED]"),
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Public configurable forms never need the large payload allowance used by
// administrative import/backup routes. Parse them first with a strict limit.
app.use("/api/public/formularios", express.json({ limit: "128kb" }));
app.use("/api/public/formalizacao", express.json({ limit: "128kb" }));
app.use("/api/public/interesse", express.json({ limit: "128kb" }));
// Webhook do Hablla: público até a checagem do token, então corpo pequeno.
app.use("/api/webhooks/hablla", express.json({ limit: "256kb" }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/api", router);
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (
    err &&
    typeof err === "object" &&
    "type" in err &&
    err.type === "entity.too.large"
  ) {
    res.status(413).json({ error: "O formulário excede o tamanho permitido." });
    return;
  }
  next(err);
});

export default app;
