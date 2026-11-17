import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

export interface DynamicFormField {
  key: string;
  label: string;
  type: 'text' | 'email' | 'tel' | 'date' | 'textarea' | 'select';
  required: boolean;
  active?: boolean;
  options?: string[];
}

interface DynamicFormProps {
  fields: DynamicFormField[];
  /** O segundo argumento diz se a caixa de consentimento do WhatsApp estava marcada (sempre false sem `consentimento`). */
  onSubmit: (respostas: Record<string, string>, consentimentoWhatsapp: boolean) => Promise<void>;
  buttonText?: string;
  /** Texto da caixa de consentimento do WhatsApp. Sem ele, o formulário não mostra a caixa. A caixa nasce desmarcada. */
  consentimento?: { texto: string };
}

export function DynamicForm({ fields, onSubmit, buttonText = "Enviar", consentimento }: DynamicFormProps) {
  const activeFields = fields.filter(field => field.active !== false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [consentiu, setConsentiu] = useState(false);

  const setAnswer = (key: string, value: string) => {
    setAnswers(prev => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validation
    const missing = activeFields.filter(f => f.required && (!answers[f.key] || answers[f.key].toString().trim() === ''));
    if (missing.length > 0) {
      toast.error(`Preencha os campos obrigatórios: ${missing.map(m => m.label).join(', ')}`);
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(answers, Boolean(consentimento) && consentiu);
    } catch {
      // Error handled by parent
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {activeFields.map(field => {
        const value = answers[field.key] || '';

        return (
          <div key={field.key} className="space-y-1.5">
            <Label className="text-sm font-semibold text-foreground">
              {field.label} {field.required && <span className="text-destructive">*</span>}
            </Label>

            {field.type === 'text' && (
              <Input
                value={value}
                onChange={e => setAnswer(field.key, e.target.value)}
                required={field.required}
                className="h-11 rounded-lg"
              />
            )}

            {field.type === 'email' && (
              <Input
                type="email"
                value={value}
                onChange={e => setAnswer(field.key, e.target.value)}
                required={field.required}
                className="h-11 rounded-lg"
              />
            )}

            {field.type === 'tel' && (
              <Input
                type="tel"
                value={value}
                onChange={e => setAnswer(field.key, e.target.value)}
                required={field.required}
                className="h-11 rounded-lg"
                placeholder="(11) 99999-9999"
              />
            )}

            {field.type === 'date' && (
              <Input
                type="date"
                value={value}
                onChange={e => setAnswer(field.key, e.target.value)}
                required={field.required}
                className="h-11 rounded-lg"
              />
            )}

            {field.type === 'textarea' && (
              <Textarea
                value={value}
                onChange={e => setAnswer(field.key, e.target.value)}
                required={field.required}
                className="min-h-[100px] rounded-lg resize-none text-sm"
              />
            )}

            {field.type === 'select' && (
              <Select
                value={value}
                onValueChange={v => setAnswer(field.key, v)}
                required={field.required}
              >
                <SelectTrigger className="h-11 rounded-lg">
                  <SelectValue placeholder="— selecione —" />
                </SelectTrigger>
                <SelectContent>
                  {field.options?.map(opt => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        );
      })}

      {consentimento && (
        <div className="flex items-start gap-2.5">
          <Checkbox
            id="consentimento-whatsapp"
            checked={consentiu}
            onCheckedChange={checked => setConsentiu(checked === true)}
            data-testid="input-consentimento"
            className="mt-0.5"
          />
          <Label htmlFor="consentimento-whatsapp" className="text-sm font-normal leading-snug text-foreground cursor-pointer">
            {consentimento.texto}
          </Label>
        </div>
      )}

      <div className="pt-2">
        <Button type="submit" disabled={submitting} className="w-full h-12 rounded-lg text-base font-semibold">
          {submitting ? "Enviando..." : buttonText}
        </Button>
      </div>
    </form>
  );
}