-- Anexos e mídia no atendimento do cartão do CRM: imagens, vídeos, áudios e documentos trocados pelo WhatsApp.
-- Tudo aditivo e repetível. O arquivo fica no armazenamento de arquivos do projeto (nunca no banco); aqui só o
-- registro: um anexo por mensagem, com tipo, nome, formato, tamanho, hash, direção, estado da cópia e motivo da
-- recusa. A legenda é o texto da própria mensagem (messages.content). Nos arquivos recebidos, visto_em/visto_por
-- dizem quem da equipe viu e quando (vazio = não visto) e alimentam o aviso de conversas aguardando a equipe.
-- messages.kind não tem restrição CHECK: os novos valores "anexo" e "aviso_anexo" não exigem nova restrição.
BEGIN;

CREATE TABLE IF NOT EXISTS mensagem_anexos (
  id serial PRIMARY KEY,
  message_id integer NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id integer NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direcao text NOT NULL CONSTRAINT mensagem_anexos_direcao_check CHECK (direcao IN ('recebido', 'enviado')),
  tipo text NOT NULL CONSTRAINT mensagem_anexos_tipo_check CHECK (tipo IN ('image', 'video', 'audio', 'document')),
  -- Nome do arquivo (documentos) ou um nome neutro gerado; nunca vai para log.
  nome text,
  mime_type text,
  tamanho_bytes bigint,
  sha256 text,
  copia text NOT NULL CONSTRAINT mensagem_anexos_copia_check CHECK (copia IN ('pendente', 'copiado', 'indisponivel', 'recusado')),
  -- Código do motivo da recusa ou da indisponibilidade (a tela traduz); nunca texto de erro do provedor.
  motivo text,
  storage_key text,
  -- Endereço do arquivo no provedor, só enquanto a cópia ainda pode ser tentada de novo; nunca vai para log.
  url_origem text,
  -- Id da mensagem na Meta (recebidos): a mesma notificação repetida não duplica o anexo.
  externo_id text,
  visto_em timestamptz,
  visto_por integer REFERENCES soundos_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mensagem_anexos_copiado_com_arquivo_check CHECK (copia <> 'copiado' OR storage_key IS NOT NULL),
  CONSTRAINT mensagem_anexos_visto_so_recebido_check CHECK (direcao = 'recebido' OR (visto_em IS NULL AND visto_por IS NULL))
);

-- Um arquivo por mensagem.
CREATE UNIQUE INDEX IF NOT EXISTS mensagem_anexos_message_uq ON mensagem_anexos (message_id);
CREATE UNIQUE INDEX IF NOT EXISTS mensagem_anexos_externo_uq ON mensagem_anexos (externo_id)
  WHERE direcao = 'recebido' AND externo_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mensagem_anexos_conversa_idx ON mensagem_anexos (conversation_id);
CREATE INDEX IF NOT EXISTS mensagem_anexos_nao_vistos_idx ON mensagem_anexos (conversation_id)
  WHERE direcao = 'recebido' AND visto_em IS NULL;

COMMIT;
