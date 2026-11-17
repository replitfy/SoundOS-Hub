import { PaymentRequiredNotice } from "@/components/payment-required-notice";

// Inscrições genéricas (/inscricao e /inscricao/:slug) foram desativadas:
// a matrícula só é formalizada por link individual emitido após o pagamento.
export default function InscricaoPage() {
  const isEmbed = new URLSearchParams(window.location.search).get("embed") === "1";
  return <PaymentRequiredNotice embed={isEmbed} />;
}
