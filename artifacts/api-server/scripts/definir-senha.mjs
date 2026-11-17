/**
 * Resgate de acesso: define a senha de um usuário direto no banco.
 *
 * Existe porque toda rota de redefinição de senha exige um admin já autenticado.
 * Se todos os admins ficarem sem senha utilizável (foi o que a migração 015 fez ao
 * apagar os hashes falsos `hash_*`), ninguém consegue entrar para destravar ninguém.
 * Este script é a única porta de entrada nesse cenário.
 *
 * Usa `psql` em vez do driver `pg` de propósito: assim não depende de nenhum pacote
 * além do bcryptjs que o próprio servidor já usa, e continua funcionando mesmo com o
 * node_modules pela metade — que é justamente o cenário de desastre em que ele serve.
 *
 * Uso (rode a partir da raiz do projeto; a senha vai por variável de ambiente, não
 * por argumento, para não ficar no histórico do shell):
 *
 *   NOVA_SENHA='sua-senha-aqui' node artifacts/api-server/scripts/definir-senha.mjs alguem@email.com
 *
 * Para ver quem está travado:
 *
 *   node artifacts/api-server/scripts/definir-senha.mjs --listar
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// bcryptjs vive nas dependências do api-server; resolve a partir deste arquivo.
const require = createRequire(import.meta.url);
const bcrypt = require("bcryptjs");

// Mesmo custo usado pela aplicação (BCRYPT_ROUNDS em routes/admin.ts).
const BCRYPT_ROUNDS = 12;

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error("DATABASE_URL não está definida.");
  process.exit(1);
}

/**
 * Monta o ambiente do psql a partir da DATABASE_URL.
 *
 * A connection string NÃO é passada como argumento porque argumentos de processo são
 * legíveis por qualquer um que rode `ps` — e ela contém a senha do banco. Pelas
 * variáveis PG* o psql conecta sem nada sensível aparecer na linha de comando.
 */
function ambientePsql() {
  const url = new URL(DATABASE_URL);
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
    PGCONNECT_TIMEOUT: "10",
  };
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  // O filho não tem motivo nenhum para enxergar a senha nova.
  delete env.NOVA_SENHA;
  return env;
}

const env = ambientePsql();

/**
 * Executa SQL passando o texto por stdin, nunca por argumento — o UPDATE carrega o
 * hash bcrypt, que não deve aparecer em `ps` nem em log de erro.
 *
 * `standard_conforming_strings = on` é fixado no início de todo script porque o
 * escape de aspas usado abaixo (duplicar `'`) só é correto sob essa configuração.
 */
function psql(sql) {
  try {
    return execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-tAF|", "-q", "-f", "-"], {
      input: `SET standard_conforming_strings = on;\n${sql}`,
      encoding: "utf8",
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (erro) {
    // A exceção do execFileSync traz o comando e os buffers; só o stderr do psql
    // interessa, e ele não contém o SQL enviado por stdin.
    const detalhe = (erro.stderr || "").toString().trim();
    console.error("Falha ao executar o psql." + (detalhe ? `\n${detalhe}` : ""));
    process.exit(1);
  }
}

/** Literal SQL seguro para texto (válido sob standard_conforming_strings=on). */
const lit = (valor) => `'${String(valor).replace(/'/g, "''")}'`;

const arg = process.argv[2];

if (!arg || arg === "--listar") {
  const saida = psql(
    `SELECT email, role, active,
            (password_hash IS NULL OR password_must_reset) AS travado
       FROM soundos_users
      ORDER BY role, email;`,
  );
  console.log("\nUsuários:\n");
  for (const linha of saida.split("\n").filter(Boolean)) {
    const [email, role, active, travado] = linha.split("|");
    const estado = travado === "t" ? "PRECISA DE SENHA" : "ok";
    const inativo = active === "t" ? "" : " (inativo)";
    console.log(`  ${estado.padEnd(17)} ${role.padEnd(13)} ${email}${inativo}`);
  }
  if (!arg) {
    console.log(
      "\nPara definir uma senha:\n" +
        "  NOVA_SENHA='sua-senha' node artifacts/api-server/scripts/definir-senha.mjs <email>\n",
    );
  }
  process.exit(0);
}

const email = arg.trim().toLowerCase();
const senha = process.env.NOVA_SENHA;

if (!senha) {
  console.error(
    "Defina a senha na variável NOVA_SENHA, não como argumento:\n" +
      `  NOVA_SENHA='sua-senha' node artifacts/api-server/scripts/definir-senha.mjs ${email}`,
  );
  process.exit(1);
}
if (senha.length < 8) {
  console.error("A senha precisa ter ao menos 8 caracteres (mesma regra da aplicação).");
  process.exit(1);
}

const encontrado = psql(`SELECT id, role, active FROM soundos_users WHERE email = ${lit(email)};`);
if (!encontrado) {
  console.error(`Nenhum usuário com o e-mail "${email}". Rode com --listar para ver os existentes.`);
  process.exit(1);
}
const [id, role, active] = encontrado.split("|");

const hash = bcrypt.hashSync(senha, BCRYPT_ROUNDS);

// Atualiza pela chave primária: atinge exatamente um registro, sem depender do
// e-mail de novo.
const afetados = psql(
  `WITH alvo AS (
     UPDATE soundos_users
        SET password_hash = ${lit(hash)},
            password_must_reset = false
      WHERE id = ${Number(id)}
      RETURNING 1
   )
   SELECT count(*) FROM alvo;`,
);

if (afetados !== "1") {
  console.error(`Esperava atualizar 1 usuário, mas foram ${afetados}. Nada garantido — verifique o banco.`);
  process.exit(1);
}

console.log(`Senha definida para ${email} (${role}).`);
if (active !== "t") {
  console.log("Atenção: este usuário está inativo e ainda não conseguirá entrar.");
}
console.log("Já dá para fazer login e redefinir a senha dos demais pela tela de admin.");
