---
name: Migração que invalida credenciais tranca o sistema inteiro
description: Não há seed de admin nem "esqueci a senha"; toda redefinição exige um admin já logado.
---

Toda rota que define senha exige um admin **já autenticado**, e a troca de senha do próprio
perfil exige saber a senha atual. Não existe seed de admin no boot nem fluxo de recuperação.

**Regra:** nenhuma migração pode invalidar credenciais sem que sobre um caminho de entrada.
Se não sobrar, o meio de resgate tem que ser entregue **junto** com a migração, e o aviso
precisa acompanhar o deploy em produção — o estrago só aparece lá quando a migração roda
sobre dados reais.

**Why:** a migração que converteu os hashes falsos para bcrypt teve de apagá-los (não dá
para recuperar a senha original) e marcou todo mundo para redefinição. Como os admins
também foram apagados, não sobrou ninguém capaz de destravar ninguém — o sistema ficou
inacessível por completo, sem nada na aplicação para reverter isso.

**How to apply:** o resgate é `artifacts/api-server/scripts/definir-senha.mjs`, que escreve
o hash direto no banco (instruções de uso no cabeçalho do próprio arquivo). Ao escrever
qualquer migração que mexa em autenticação, pergunte antes: depois disto, quem consegue
entrar? Se a resposta for "ninguém", o plano está incompleto.
