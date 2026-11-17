#!/bin/bash
set -euo pipefail

# O registro de pacotes já devolveu 502 no meio de um merge. Uma falha transitória
# de rede não deve derrubar o setup inteiro, então tenta de novo antes de desistir.
for tentativa in 1 2 3; do
  if pnpm install --frozen-lockfile; then
    break
  fi
  if [ "$tentativa" = 3 ]; then
    echo "pnpm install falhou após 3 tentativas" >&2
    exit 1
  fi
  echo "pnpm install falhou (tentativa $tentativa/3); repetindo em 5s..." >&2
  sleep 5
done

# Regenera os .d.ts das libs (project references). Sem isto, um merge que muda um
# schema em lib/db deixa as declarações em lib/db/dist velhas e o typecheck dos
# artifacts quebra apontando para campos que "não existem" mas existem na fonte.
pnpm run typecheck:libs

pnpm --filter db push

# ON_ERROR_STOP=1 é obrigatório: sem ele o psql relata o erro, SEGUE para os
# statements seguintes do arquivo e ainda sai com código 0 — o `set -e` não pega
# nada. Uma migração quebrada passaria batida e as seguintes rodariam em cima de
# um schema pela metade, o que é especialmente perigoso com a 014, que é destrutiva.
migrar() {
  echo "→ $1"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$1"
}

# Idempotent migration: ensure conversations.pessoa_id column exists
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q \
  -c "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pessoa_id INTEGER REFERENCES pessoas(id);"

# pessoa_evidencias + pessoa_campos_confirmados (mecanismo de evidências do CRM)
migrar scripts/migrations/005_pessoa_evidencias.sql
# handoff automático da Sofia para atendimento humano
migrar scripts/migrations/006_conversation_handoff.sql
# conduta comercial da Sofia (messages.conduta)
migrar scripts/migrations/007_conduta_comercial.sql
# motor de decisão da Sofia (sofia_decision_runs)
migrar scripts/migrations/008_sofia_decision_runs.sql
# conduta_config (editor admin da conduta comercial da Sofia)
migrar scripts/migrations/009_conduta_config.sql
# courseId em cursos_inscricao (links de inscrição ligados ao catálogo)
migrar scripts/migrations/010_cursos_inscricao_course_id.sql
# pessoa_servicos.cursos_inscricao_id (liga o inscrito ao link de origem)
migrar scripts/migrations/011_pessoa_servicos_cursos_inscricao_id.sql
# índice de decision_runs por conversa/data
migrar scripts/migrations/012_decision_runs_conversation_created_idx.sql
# cursos_inscricao.class_id (cada turma tem o seu link de inscrição)
migrar scripts/migrations/013_cursos_inscricao_class_id.sql
# Matrículas passam a apontar para `pessoas` e a tabela `students` é removida.
# Destrutiva por natureza, mas auto-guardada: só age enquanto `students` existir e
# aborta sem remover nada se algum aluno/matrícula ficar sem pessoa correspondente.
migrar scripts/migrations/014_enrollments_pessoa_id.sql
# Senhas bcrypt: adiciona password_must_reset e limpa os hashes falsos `hash_*`.
# ATENÇÃO: num banco que ainda tenha hashes falsos, isto deixa TODOS os usuários sem
# senha, inclusive os admins — e não há fluxo de recuperação na aplicação. Use
# `node artifacts/api-server/scripts/definir-senha.mjs` para destravar o primeiro admin.
migrar scripts/migrations/015_users_bcrypt_passwords.sql
# Arquivamento reversível de pessoas, separado do status ativo/inativo.
migrar scripts/migrations/016_pessoas_arquivado_em.sql
# Taxonomia de eventos: Education x Experiences e tipo de oferta.
migrar scripts/migrations/017_cursos_inscricao_taxonomia_eventos.sql
# Formulários versionados por evento, incluindo backfill dos eventos existentes
# e trigger para eventos criados fora da API.
migrar scripts/migrations/018_evento_formularios.sql
# Restaura os campos de seleção e suas opções no formulário completo.
migrar scripts/migrations/019_restaurar_selects_formulario_matricula.sql
# Registry is additive and intentionally migrated with SQL (pessoas schema drift).
migrar scripts/migrations/020_sofia_entity_registry.sql
# CRM opportunities require SQL-only checks and an append-only audit trigger
# that are not represented by the Drizzle schema model.
migrar scripts/migrations/021_commercial_opportunities.sql
# Telefones compartilhados permanecem em fichas separadas quando os nomes divergem.
migrar scripts/migrations/022_pessoas_shared_phone.sql
# Vocabulário canônico para turmas e matrículas históricas.
migrar scripts/migrations/023_normalize_historical_import_statuses.sql
# Turmas históricas podem preservar legitimamente um dia desconhecido como NULL.
migrar scripts/migrations/024_allow_undated_historical_classes.sql
# Auditoria e chaves duráveis para a sincronização Airtable → SoundOS.
migrar scripts/migrations/025_airtable_soundos_sync.sql
# Piloto factual canônico da Sofia, sem capacidades comerciais.
migrar scripts/migrations/026_sofia_factual_pilot.sql
# Auditoria factual antes de a conversa estar ligada a uma pessoa.
migrar scripts/migrations/031_allow_anonymous_sofia_decision_audit.sql
# Sofia modo simples: flag de modo, aliases de eventos, vídeo ↔ evento e idade declarada.
migrar scripts/migrations/033_sofia_modo_simples.sql
# Cartão de interesse da Sofia entra no CRM sem responsável (origem SOFIA_INTERESSE).
migrar scripts/migrations/034_crm_oportunidade_sem_responsavel.sql
# Sofia atende o Instagram pelo Hablla: canal na conversa, eventos, envios e chave de resposta.
migrar scripts/migrations/035_sofia_instagram_hablla.sql
# Perfis de acesso: tabela access_profiles e soundos_users.profile_id. Os perfis do
# sistema e o vínculo dos usuários existentes nascem do código ao subir o servidor.
migrar scripts/migrations/036_access_profiles.sql
migrar scripts/migrations/037_event_formalizations.sql
# Sofia atende o WhatsApp pelo Hablla: canal na conversa, chave e token próprios, estado de entrega dos envios.
migrar scripts/migrations/038_sofia_whatsapp_hablla.sql
# Formulário de interesse genérico (Wix): tabela de envios com grupo e página de origem.
migrar scripts/migrations/039_interesse_geral_submissoes.sql
# CRM com lista, modal e WhatsApp: informações, observações, tarefas, compromissos, autor das mensagens e registro de autorização de contato.
migrar scripts/migrations/040_crm_atendimento.sql
# Sofia inicia a conversa com quem consentiu no formulário: autor de sistema nos registros de contato, consentimento nos envios, chave e registro de tentativas.
migrar scripts/migrations/041_sofia_primeiro_contato_formulario.sql
# Anexos e mídia no atendimento do cartão: registro de anexos por mensagem (arquivo no armazenamento do projeto) e "não visto" para o aviso à equipe.
migrar scripts/migrations/042_anexos_atendimento.sql
# Carga de clientes novos do Airtable pela tela: colunas opcionais e índices de execução única em airtable_sync_runs.
migrar scripts/migrations/043_airtable_carga_novos_clientes.sql
