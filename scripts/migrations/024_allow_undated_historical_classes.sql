-- Turmas históricas vindas de fontes que preservam apenas mês/ano devem
-- existir sem que o sistema invente um dia para satisfazer o schema.
-- A API continua exigindo datas para toda nova turma operacional.
ALTER TABLE classes ALTER COLUMN start_date DROP NOT NULL;
ALTER TABLE classes ALTER COLUMN end_date DROP NOT NULL;