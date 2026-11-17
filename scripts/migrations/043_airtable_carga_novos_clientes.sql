-- Carga de clientes novos do Airtable pela tela de administração.
-- Só acrescenta colunas opcionais e dois índices parciais à tabela de execuções já existente
-- (airtable_sync_runs, criada na 025). As restrições CHECK de mode e status NÃO mudam: prévia usa
-- mode = 'dry-run' e carga usa mode = 'execute', como o comando de linha. `scope` separa as execuções da
-- tela das do comando de linha. Repetível.
BEGIN;

ALTER TABLE airtable_sync_runs ADD COLUMN IF NOT EXISTS scope text;
ALTER TABLE airtable_sync_runs ADD COLUMN IF NOT EXISTS requested_by integer;
ALTER TABLE airtable_sync_runs ADD COLUMN IF NOT EXISTS step text;
ALTER TABLE airtable_sync_runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
-- Prévia em que uma carga se baseou.
ALTER TABLE airtable_sync_runs ADD COLUMN IF NOT EXISTS preview_run_id bigint;
-- Código estável do motivo da falha (a tela traduz); error_message guarda só texto técnico sem dados de pessoas.
ALTER TABLE airtable_sync_runs ADD COLUMN IF NOT EXISTS error_code text;

-- Só uma execução da tela por vez, garantido pelo banco (vale para qualquer instância do servidor).
CREATE UNIQUE INDEX IF NOT EXISTS airtable_sync_runs_um_em_andamento_idx
  ON airtable_sync_runs ((true))
  WHERE scope = 'novos_clientes' AND status = 'running';

-- Uma prévia autoriza no máximo uma carga.
CREATE UNIQUE INDEX IF NOT EXISTS airtable_sync_runs_previa_usada_idx
  ON airtable_sync_runs (preview_run_id)
  WHERE scope = 'novos_clientes' AND mode = 'execute' AND preview_run_id IS NOT NULL AND status IN ('running', 'completed');

COMMIT;
