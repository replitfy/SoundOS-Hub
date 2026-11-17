import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useForm, Controller } from "react-hook-form";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { 
  useCreateCommercialOpportunity, 
  useListPessoaOptions, 
  useListCommercialOpportunityOwners,
  useListCursosInscricao,
  OpportunityNucleus, 
  OpportunityTaskType,
  getListCommercialOpportunitiesQueryKey
} from "@workspace/api-client-react";
import { useLang } from "@/contexts/language";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { isCurrentOrFutureEvent } from "../event-visibility";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDateBR } from "@/lib/date";

type SearchableOption = {
  value: string;
  label: string;
  searchValue?: string;
  content?: ReactNode;
};

function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  ariaLabel,
  invalid = false,
  testId,
  onSearchValueChange,
}: {
  value?: string;
  onValueChange: (value: string) => void;
  options: SearchableOption[];
  placeholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
  ariaLabel: string;
  invalid?: boolean;
  testId: string;
  onSearchValueChange?: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-invalid={invalid}
          className={cn("w-full min-w-0 justify-between font-normal", invalid && "border-destructive")}
          data-testid={testId}
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0"
      >
        <Command shouldFilter={!onSearchValueChange}>
          <CommandInput
            placeholder={searchPlaceholder}
            onValueChange={onSearchValueChange}
            data-testid={`${testId}-search`}
          />
          <CommandList className="max-h-[min(280px,var(--radix-popover-content-available-height))]">
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {options.map(option => (
              <CommandItem
                key={option.value}
                value={option.searchValue ?? `${option.label} ${option.value}`}
                aria-label={option.label}
                onSelect={() => {
                  onValueChange(option.value);
                  setOpen(false);
                }}
              >
                <Check className={cn("h-4 w-4 shrink-0", value === option.value ? "opacity-100" : "opacity-0")} />
                {option.content ?? <span className="truncate">{option.label}</span>}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function CreateOpportunityDialog({ open, onOpenChange }: { open: boolean, onOpenChange: (val: boolean) => void }) {
  const { t, lang } = useLang();
  const [eventSelectOpen, setEventSelectOpen] = useState(false);
  const [personSearchInput, setPersonSearchInput] = useState("");
  const [personSearch, setPersonSearch] = useState("");
  const searchPlaceholder = `${t("common.buscar")}...`;
  const emptyMessage = lang === "fr" ? "Aucun résultat trouvé." : "Nenhum resultado encontrado.";
  
  const schema = z.object({
    pessoaId: z.coerce.number().min(1, t("crm.form.person_error")),
    nucleus: z.enum(["EDUCATION", "EXPERIENCES"]),
    cursosInscricaoId: z.coerce.number().optional().nullable(),
    offerLabel: z.string().optional().nullable(),
    ownerUserId: z.coerce.number().optional().nullable(),
    nextTaskType: z.enum(["CALL", "WHATSAPP", "EMAIL", "MEETING", "INTERNAL"]),
    nextTaskText: z.string().min(1, t("crm.form.desc_error")),
    nextTaskAt: z.string().min(1, t("crm.form.date_error")),
  });

  type FormValues = z.infer<typeof schema>;
  const queryClient = useQueryClient();
  const createMut = useCreateCommercialOpportunity();
  
  useEffect(() => {
    const timer = window.setTimeout(() => setPersonSearch(personSearchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [personSearchInput]);

  const { data: pessoas } = useListPessoaOptions(personSearch ? { search: personSearch } : undefined);
  const { data: owners } = useListCommercialOpportunityOwners();
  const { data: cursos } = useListCursosInscricao();
  const selectableCursos = (cursos ?? [])
    .filter(curso => isCurrentOrFutureEvent(curso))
    .sort((a, b) => (a.dataInicio ?? "").localeCompare(b.dataInicio ?? ""));

  const { control, handleSubmit, watch, reset, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      nucleus: "EDUCATION",
      nextTaskType: "INTERNAL",
      nextTaskText: t("crm.task.initial_contact" as any),
      nextTaskAt: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
    }
  });

  const nucleus = watch("nucleus");

  const onSubmit = (data: FormValues) => {
    createMut.mutate({
      data: {
        pessoaId: data.pessoaId,
        nucleus: data.nucleus as OpportunityNucleus,
        cursosInscricaoId: data.cursosInscricaoId || undefined,
        offerLabel: data.offerLabel || undefined,
        ownerUserId: data.ownerUserId || undefined,
        nextTaskType: data.nextTaskType as OpportunityTaskType,
        nextTaskText: data.nextTaskText,
        nextTaskAt: new Date(data.nextTaskAt).toISOString(),
      }
    }, {
      onSuccess: () => {
        toast.success(t("crm.msg.created"));
        queryClient.invalidateQueries({ queryKey: getListCommercialOpportunitiesQueryKey() });
        reset();
        onOpenChange(false);
      },
      onError: () => {
        toast.error(t("crm.msg.create_error"));
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("crm.nova_oportunidade")}</DialogTitle>
        </DialogHeader>
        
        <form onSubmit={handleSubmit(onSubmit)} className="min-w-0 space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-xs font-medium">{t("crm.form.person")}</label>
            <Controller
              name="pessoaId"
              control={control}
              render={({ field }) => (
                <SearchableSelect
                  value={field.value?.toString()}
                  onValueChange={field.onChange}
                  options={(pessoas ?? []).map(p => ({
                    value: p.id.toString(),
                    label: p.nome,
                    searchValue: `${p.nome} ${p.email ?? ""}`,
                    content: (
                      <span className="min-w-0">
                        <span className="block truncate">{p.nome}</span>
                        {p.email && <span className="block truncate text-xs text-muted-foreground">{p.email}</span>}
                      </span>
                    ),
                  }))}
                  placeholder={t("crm.form.person_placeholder")}
                  searchPlaceholder={searchPlaceholder}
                  emptyMessage={emptyMessage}
                  ariaLabel={t("crm.form.person")}
                  invalid={Boolean(errors.pessoaId)}
                  testId="crm-create-person"
                  onSearchValueChange={setPersonSearchInput}
                />
              )}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <label className="text-xs font-medium">{t("crm.form.nucleus")}</label>
              <Controller
                name="nucleus"
                control={control}
                render={({ field }) => (
                  <SearchableSelect
                    value={field.value}
                    onValueChange={field.onChange}
                    options={[
                      { value: "EDUCATION", label: t("crm.nucleus.EDUCATION") },
                      { value: "EXPERIENCES", label: t("crm.nucleus.EXPERIENCES") },
                    ]}
                    placeholder={t("crm.form.nucleus")}
                    searchPlaceholder={searchPlaceholder}
                    emptyMessage={emptyMessage}
                    ariaLabel={t("crm.form.nucleus")}
                    testId="crm-create-nucleus"
                  />
                )}
              />
            </div>
            
            <div className="min-w-0 space-y-2">
              <label className="text-xs font-medium">{t("crm.form.owner")}</label>
              <Controller
                name="ownerUserId"
                control={control}
                render={({ field }) => (
                  <SearchableSelect
                    value={field.value?.toString() || "auto"}
                    onValueChange={value => field.onChange(value === "auto" ? null : value)}
                    options={[
                      { value: "auto", label: t("crm.form.owner_auto") },
                      ...(owners ?? []).map(owner => ({ value: owner.id.toString(), label: owner.name })),
                    ]}
                    placeholder={t("crm.form.owner_auto")}
                    searchPlaceholder={searchPlaceholder}
                    emptyMessage={emptyMessage}
                    ariaLabel={t("crm.form.owner")}
                    testId="crm-create-owner"
                  />
                )}
              />
            </div>
          </div>

          {nucleus === "EDUCATION" && (
            <div className="space-y-2">
              <label className="text-xs font-medium">{t("crm.form.course")}</label>
              <Controller
                name="cursosInscricaoId"
                control={control}
                render={({ field }) => (
                  <Popover open={eventSelectOpen} onOpenChange={setEventSelectOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        role="combobox"
                        aria-expanded={eventSelectOpen}
                        className="w-full min-w-0 justify-between font-normal"
                      >
                        <span className="truncate">
                          {selectableCursos.find(c => c.id === field.value)?.nome
                            ?? t("crm.form.course_placeholder")}
                        </span>
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="start"
                      collisionPadding={16}
                      className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0"
                    >
                      <Command>
                        <CommandInput placeholder={t("crm.form.course_search")} />
                        <CommandList className="max-h-[min(280px,var(--radix-popover-content-available-height))]">
                          <CommandEmpty>{t("crm.form.course_empty")}</CommandEmpty>
                          {selectableCursos.map(c => (
                            <CommandItem
                              key={c.id}
                              value={`${c.nome} ${c.dataInicio ?? ""}`}
                              aria-label={c.nome}
                              onSelect={() => {
                                field.onChange(c.id);
                                setEventSelectOpen(false);
                              }}
                            >
                              <Check className={cn("h-4 w-4 shrink-0", field.value === c.id ? "opacity-100" : "opacity-0")} />
                              <span className="min-w-0 flex-1 truncate">{c.nome}</span>
                              {c.dataInicio && (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {formatDateBR(c.dataInicio)}
                                </span>
                              )}
                            </CommandItem>
                          ))}
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                )}
              />
            </div>
          )}

          {nucleus === "EXPERIENCES" && (
            <div className="space-y-2">
              <label className="text-xs font-medium">{t("crm.form.offer")}</label>
              <Controller
                name="offerLabel"
                control={control}
                render={({ field }) => (
                  <Input placeholder={t("crm.form.offer_placeholder")} {...field} value={field.value || ""} />
                )}
              />
            </div>
          )}

          <div className="pt-2 border-t">
            <h4 className="text-xs font-bold mb-3 uppercase tracking-wider text-muted-foreground">{t("crm.form.next_action")}</h4>
            <div className="mb-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="min-w-0 space-y-2">
                <label className="text-xs font-medium">{t("crm.form.type")}</label>
                <Controller
                  name="nextTaskType"
                  control={control}
                  render={({ field }) => (
                    <SearchableSelect
                      value={field.value}
                      onValueChange={field.onChange}
                      options={["CALL", "WHATSAPP", "EMAIL", "MEETING", "INTERNAL"].map(value => ({
                        value,
                        label: t(`crm.task.${value}` as any),
                      }))}
                      placeholder={t("crm.form.type")}
                      searchPlaceholder={searchPlaceholder}
                      emptyMessage={emptyMessage}
                      ariaLabel={t("crm.form.type")}
                      testId="crm-create-task-type"
                    />
                  )}
                />
              </div>
              <div className="min-w-0 space-y-2">
                <label className="text-xs font-medium">{t("crm.form.date")}</label>
                <Controller
                  name="nextTaskAt"
                  control={control}
                  render={({ field }) => (
                    <Input type="datetime-local" {...field} className={cn("w-full min-w-0", errors.nextTaskAt && "border-destructive")} />
                  )}
                />
              </div>
            </div>
            
            <div className="space-y-2">
              <label className="text-xs font-medium">{t("crm.form.desc")}</label>
              <Controller
                name="nextTaskText"
                control={control}
                render={({ field }) => (
                  <Input placeholder={t("crm.form.desc_placeholder")} {...field} className={errors.nextTaskText ? "border-destructive" : ""} />
                )}
              />
            </div>
          </div>

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancelar")}</Button>
            <Button type="submit" disabled={createMut.isPending}>
              {createMut.isPending ? t("common.salvando") : t("crm.form.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
