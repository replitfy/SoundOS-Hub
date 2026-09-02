---
name: Aluno é uma pessoa do CRM com matrícula (não existe tabela de alunos)
description: Modelo do módulo Education ligado ao CRM, e por que a lista de Alunos é derivada e somente leitura.
---

**Regra:** não existe cadastro de aluno separado. Um "aluno" é uma linha de `pessoas`
(o CRM) que tem ao menos uma matrícula em `enrollments`. A lista de Alunos é *derivada*
de `enrollments` e por isso é somente leitura: não tem POST/PATCH/DELETE. Uma pessoa
vira aluna ao ser matriculada, e os dados dela são editados na ficha do CRM
(`/pessoas/:id`).

**Why:** antes havia uma tabela `students` paralela a `pessoas`. A mesma pessoa existia
nos dois lugares sem ligação nenhuma, e as duas fontes de verdade divergiam. Mais grave:
a ficha do CRM é o único caminho que respeita as regras de evidência (ver
`pessoa-evidencias-mecanismo.md`) — um cadastro de aluno editável em paralelo seria um
jeito de contornar essa invariante sem perceber.

**How to apply:** ao adicionar qualquer tela ou rota que pareça precisar de "cadastro de
aluno", ligue a `pessoas` em vez de criar uma tabela nova. Contagens de alunos usam
`countDistinct(enrollments.pessoaId)`, nunca `count(*)` de matrículas.

**Link de inscrição por turma:** cada turma gera automaticamente o seu próprio link
público (`cursos_inscricao.class_id`, único parcial — links avulsos têm `class_id NULL`).
O slug é derivado do código da turma e **nunca muda depois de criado**, mesmo que a turma
seja renomeada, porque um link já divulgado não pode parar de funcionar; só o conteúdo
(nome exibido, local, datas) é ressincronizado. Excluir a turma **desativa** o link
(`ativo=false`, `class_id=NULL`) em vez de apagá-lo, porque `pessoa_servicos` referencia
o id do link e apagá-lo destruiria o histórico de inscritos.
