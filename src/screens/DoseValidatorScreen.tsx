import React, { useEffect, useRef, useState } from "react";
import { Keyboard, Platform, ScrollView, View } from "react-native";
import { Controller, useForm } from "react-hook-form";
import {
  ActivityIndicator,
  Button,
  Card,
  Divider,
  HelperText,
  List,
  SegmentedButtons,
  Snackbar,
  Surface,
  Text,
  TextInput,
  useTheme,
} from "react-native-paper";
import {
  searchBrandSuggestions,
  type BrandSuggestion,
} from "../lib/drugSearch";
import { type GuardrailsResult } from "../lib/guardrailsEngine";
import { supabase } from "../lib/supabase";

type NativeDateTimePickerEvent = {
  type: "set" | "dismissed";
};

type NativeDateTimePickerProps = {
  value: Date;
  mode: "date" | "time";
  display?: "default" | "spinner" | "calendar" | "clock" | "inline";
  onChange: (event: NativeDateTimePickerEvent, date?: Date) => void;
};

const NativeDateTimePicker = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@react-native-community/datetimepicker");
    return (mod?.default ??
      mod) as React.ComponentType<NativeDateTimePickerProps>;
  } catch {
    return null;
  }
})();

type FormValues = {
  patientName: string;
  weightKg?: string;
  gender?: "male" | "female" | "other";
  ageYears?: string;
  drugName?: string;
  lastDoseMg?: string;
  notes?: string;
};

type PmCacheCandidate = {
  drug_code: string | null;
  pm_date: string | null;
  updated_at: string | null;
};

type PmCounts = { ok: number; noPdf: number; fail: number; total: number };

const defaultFormValues: FormValues = {
  patientName: "",
  weightKg: "",
  ageYears: "",
  gender: "other",
  drugName: "",
  lastDoseMg: "",
  notes: "",
};

function formatLastTaken(date: Date | null): string {
  if (!date) return "Select date/time";
  const datePart = date.toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timePart = date.toLocaleTimeString("en-CA", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${datePart} • ${timePart}`;
}

function formatIsoOrDash(value: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function DoseValidatorScreen() {
  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
    setValue,
  } = useForm<FormValues>({
    defaultValues: defaultFormValues,
  });

  const theme = useTheme();

  const glassCardStyle = {
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    overflow: "hidden" as const,
  };

  const [snack, setSnack] = useState<{ visible: boolean; text: string }>({
    visible: false,
    text: "",
  });

  const [result, setResult] = useState<GuardrailsResult | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [patientSpecificNotes, setPatientSpecificNotes] = useState<
    string | null
  >(null);
  const [aiLoading, setAiLoading] = useState(false);

  const [drugQuery, setDrugQuery] = useState("");
  const [suggestions, setSuggestions] = useState<BrandSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearchResult, setHasSearchResult] = useState(false);

  const [selectedDrug, setSelectedDrug] = useState<BrandSuggestion | null>(
    null,
  );
  const [selectedDrugCode, setSelectedDrugCode] = useState<string | null>(null);
  const [selectedDrugCodes, setSelectedDrugCodes] = useState<string[]>([]);
  const [pmCacheStatus, setPmCacheStatus] = useState<
    "idle" | "loading" | "ok" | "no_pdf" | "fail"
  >("idle");
  const [pmCacheMessage, setPmCacheMessage] = useState<string | null>(null);
  const [, setPmCounts] = useState<PmCounts>({
    ok: 0,
    noPdf: 0,
    fail: 0,
    total: 0,
  });

  const [lastTakenDate, setLastTakenDate] = useState<Date | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);

  const searchRequestRef = useRef(0);

  useEffect(() => {
    const q = drugQuery.trim();

    if (selectedDrug && q === (selectedDrug.brand_name ?? "").trim()) {
      setShowSuggestions(false);
      setIsSearching(false);
      return;
    }

    if (q.length < 2) {
      setSuggestions([]);
      setShowSuggestions(false);
      setIsSearching(false);
      setHasSearchResult(false);
      return;
    }

    const requestId = ++searchRequestRef.current;
    setIsSearching(true);
    setHasSearchResult(false);

    const timer = setTimeout(async () => {
      try {
        const rows = await searchBrandSuggestions(q, 10);
        if (requestId !== searchRequestRef.current) return;

        setSuggestions(rows);
        setShowSuggestions(true);
        setHasSearchResult(true);
      } catch (e: any) {
        if (requestId !== searchRequestRef.current) return;
        setSuggestions([]);
        setShowSuggestions(true);
        setHasSearchResult(true);
        setSnack({
          visible: true,
          text: `Search failed: ${e?.message ?? "unknown"}`,
        });
      } finally {
        if (requestId === searchRequestRef.current) setIsSearching(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [drugQuery, selectedDrug]);

  const onDateChange = (event: NativeDateTimePickerEvent, selected?: Date) => {
    setShowDatePicker(false);
    if (event.type === "dismissed") return;

    const current = lastTakenDate ? new Date(lastTakenDate) : new Date();
    const nextDate = selected ? new Date(selected) : current;

    nextDate.setHours(current.getHours(), current.getMinutes(), 0, 0);
    setLastTakenDate(nextDate);

    setShowTimePicker(true);
  };

  const onTimeChange = (event: NativeDateTimePickerEvent, selected?: Date) => {
    setShowTimePicker(false);
    if (event.type === "dismissed") return;

    const base = lastTakenDate ? new Date(lastTakenDate) : new Date();
    const source = selected ? new Date(selected) : base;

    base.setHours(source.getHours(), source.getMinutes(), 0, 0);
    setLastTakenDate(base);
  };

  const openDatePicker = () => {
    if (!NativeDateTimePicker) {
      setSnack({
        visible: true,
        text: "Install @react-native-community/datetimepicker to use date/time picker.",
      });
      return;
    }
    setShowDatePicker(true);
  };

  const onSelectSuggestion = async (item: BrandSuggestion) => {
    const MAX_PREFETCH_TRIES = 10;

    setValue("drugName", item.brand_name ?? "", { shouldDirty: true });
    setDrugQuery(item.brand_name ?? "");
    setSuggestions([]);
    setShowSuggestions(false);
    setHasSearchResult(false);

    setSelectedDrug(item);
    setSelectedDrugCode(item.drug_code ?? null);
    setSelectedDrugCodes([]);
    Keyboard.dismiss();

    const fallbackCode = item.drug_code ?? null;
    if (!fallbackCode) {
      setPmCacheStatus("fail");
      setPmCacheMessage("No drug_code for this selection.");
      return;
    }

    let codes: string[] = [fallbackCode];
    const brandName = (item.brand_name ?? "").trim();
    if (brandName) {
      const { data: variantRows, error: variantError } = await supabase
        .from("dpd_drug_product_all")
        .select("drug_code")
        .ilike("brand_name", brandName)
        .limit(20);

      if (!variantError && variantRows) {
        const dedup = new Set<string>();
        for (const row of variantRows) {
          const code = String(row.drug_code ?? "").trim();
          if (!code) continue;
          dedup.add(code);
        }
        if (dedup.size > 0) {
          codes = Array.from(dedup);
        }
      }
    }
    // ensure fallback is first
    codes = [fallbackCode, ...codes.filter((c) => c !== fallbackCode)];
    // only try a few
    codes = codes.slice(0, MAX_PREFETCH_TRIES);
    setSelectedDrugCodes(codes);
    setPmCounts({ ok: 0, noPdf: 0, fail: 0, total: 0 });
    setPmCacheStatus("idle");
    setPmCacheMessage(null);
  };

  const onSubmit = async (values: FormValues) => {
    setAiSummary(null);
    setPatientSpecificNotes(null);
    setAiLoading(true);

    let chosenDrugCode = selectedDrugCode;
    if (selectedDrugCodes.length > 0) {
      const { data: cacheRows } = await supabase
        .from("dpd_pm_cache")
        .select("drug_code, cache_status, pm_date, updated_at")
        .in("drug_code", selectedDrugCodes)
        .eq("cache_status", "OK");

      if ((cacheRows?.length ?? 0) > 0) {
        const sorted = [...(cacheRows as PmCacheCandidate[])].sort((a, b) => {
          const aDate = Date.parse(String(a.pm_date ?? a.updated_at ?? 0));
          const bDate = Date.parse(String(b.pm_date ?? b.updated_at ?? 0));
          return bDate - aDate;
        });
        chosenDrugCode = String(sorted[0]?.drug_code ?? chosenDrugCode ?? "");
      }
    }

    if (selectedDrugCode) {
      setPmCacheStatus("loading");
      setPmCacheMessage("Prefetching monographs...");
      const { data: prefetchData, error: prefetchError } = await supabase.functions.invoke(
        "pm_prefetch",
        { body: { drug_code: selectedDrugCode } },
      );

      if (prefetchError) {
        setPmCounts({ ok: 0, noPdf: 0, fail: 1, total: 1 });
        setPmCacheStatus("fail");
        setPmCacheMessage("Monographs (0/1)");
      } else {
        const st = String(
          prefetchData?.details?.[0]?.status ?? prefetchData?.status ?? "",
        ).toUpperCase();
        const ok = st === "OK" ? 1 : 0;
        const noPdf = st === "NO_PDF" ? 1 : 0;
        const fail = ok === 0 && noPdf === 0 ? 1 : 0;
        setPmCounts({ ok, noPdf, fail, total: 1 });
        setPmCacheMessage(`Monographs (${ok}/1)`);
        if (ok > 0) setPmCacheStatus("ok");
        else if (noPdf > 0 && fail === 0) setPmCacheStatus("no_pdf");
        else setPmCacheStatus("fail");
      }
    }

    const { data, error: invokeError } = await supabase.functions.invoke("dose_ai", {
      body: {
        patient_name: values.patientName,
        weight_kg: values.weightKg ? Number(values.weightKg) : null,
        age_years: values.ageYears ? Number(values.ageYears) : null,
        gender: values.gender ?? null,
        drug_codes: selectedDrugCodes,
        drug_code: chosenDrugCode ?? null,
        drug_name: values.drugName ?? "",
        last_dose_mg: values.lastDoseMg ? Number(values.lastDoseMg) : null,
        last_dose_time: lastTakenDate?.toISOString() ?? null,
        patient_notes: values.notes ?? null,
      },
    });

    setAiLoading(false);

    if (invokeError) {
      setSnack({
        visible: true,
        text: `AI function error: ${invokeError.message}`,
      });
      return;
    }

    const ruleResult: GuardrailsResult = {
      status: (data?.status as GuardrailsResult["status"]) ?? "BLOCK",
      message:
        typeof data?.message === "string"
          ? data.message
          : "Calculation failed.",
      suggestedNextDoseMg:
        typeof data?.suggested_next_dose_mg === "number"
          ? data.suggested_next_dose_mg
          : null,
      timeIntervalHours:
        typeof data?.interval_hours === "number" ? data.interval_hours : null,
      nextEligibleAt:
        typeof data?.next_eligible_time === "string"
          ? data.next_eligible_time
          : null,
      capsApplied: false,
      appliedFormulaType: null,
      blockReasons: [],
      ruleVersion: "edge",
    };

    setResult(ruleResult);

    const aiSummaryValue =
      typeof data?.ai_summary === "string" && data.ai_summary.trim()
        ? data.ai_summary
        : "AI explanation unavailable.";
    setAiSummary(aiSummaryValue);
    const patientSpecificNotesValue =
      typeof data?.patient_specific_notes === "string" &&
      data.patient_specific_notes.trim()
        ? data.patient_specific_notes
        : null;
    setPatientSpecificNotes(patientSpecificNotesValue);

    if (ruleResult.status === "BLOCK" || ruleResult.status === "STOP") {
      return;
    }

    const payload = {
      patient_name: values.patientName.trim(),
      weight_kg: values.weightKg ? Number(values.weightKg) : null,
      age_years: values.ageYears ? Number(values.ageYears) : null,
      gender: values.gender ?? null,
      drug_name: values.drugName?.trim() ?? null,
      last_dose_mg: values.lastDoseMg ? Number(values.lastDoseMg) : null,
      last_dose_taken_at: lastTakenDate ? lastTakenDate.toISOString() : null,
      patient_notes: values.notes?.trim() ?? null,
      suggested_next_dose_mg: ruleResult.suggestedNextDoseMg,
      time_interval_hours: ruleResult.timeIntervalHours,
      next_eligible_at: ruleResult.nextEligibleAt,
      ai_summary: aiSummaryValue,
      patient_specific_notes: patientSpecificNotesValue,
      ai_warnings: null,
      ai_model: null,
    };

    let { error } = await supabase.from("patient_data").insert(payload);
    if (
      error &&
      typeof error.message === "string" &&
      error.message.toLowerCase().includes("patient_specific_notes")
    ) {
      const { patient_specific_notes: _omit, ...fallbackPayload } = payload;
      const fallback = await supabase
        .from("patient_data")
        .insert(fallbackPayload);
      error = fallback.error;
    }

    if (error) {
      setSnack({ visible: true, text: `Supabase error: ${error.message}` });
      return;
    }

    setSnack({ visible: true, text: "Saved patient_data record." });
  };

  return (
    <ScrollView
      nestedScrollEnabled
      keyboardShouldPersistTaps="always"
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingBottom: 28,
        paddingTop: 100,
        gap: 12,
        backgroundColor: theme.colors.background,
      }}
    >
      <Text
        variant="headlineMedium"
        style={{ fontWeight: "700", letterSpacing: 0.2 }}
      >
        Dose Validator
      </Text>
      <Text variant="bodyMedium" style={{ color: "rgba(255,255,255,0.7)" }}>
        One-page demo. Saves checks to Supabase.
      </Text>

      <Card style={glassCardStyle}>
        <Card.Title title="Patient" />
        <Card.Content style={{ gap: 10 }}>
          <Controller
            control={control}
            name="patientName"
            rules={{ required: "Patient name is required" }}
            render={({ field: { onChange, value } }) => (
              <TextInput
                label="Patient name"
                value={value ?? ""}
                onChangeText={onChange}
                outlineStyle={{ borderRadius: 16 }}
                mode="outlined"
                error={!!errors.patientName}
              />
            )}
          />
          <HelperText type="error" visible={!!errors.patientName}>
            {errors.patientName?.message}
          </HelperText>

          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Controller
                control={control}
                name="weightKg"
                render={({ field: { onChange, value } }) => (
                  <TextInput
                    label="Weight (kg)"
                    value={value ?? ""}
                    onChangeText={onChange}
                    outlineStyle={{ borderRadius: 16 }}
                    mode="outlined"
                    keyboardType="decimal-pad"
                  />
                )}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Controller
                control={control}
                name="ageYears"
                render={({ field: { onChange, value } }) => (
                  <TextInput
                    label="Age (years)"
                    value={value ?? ""}
                    onChangeText={onChange}
                    outlineStyle={{ borderRadius: 16 }}
                    mode="outlined"
                    keyboardType="number-pad"
                  />
                )}
              />
            </View>
          </View>

          <Controller
            control={control}
            name="gender"
            render={({ field: { onChange, value } }) => (
              <SegmentedButtons
                value={value ?? "other"}
                onValueChange={(v) => onChange(v as FormValues["gender"])}
                buttons={[
                  { value: "male", label: "Male" },
                  { value: "female", label: "Female" },
                  { value: "other", label: "Other" },
                ]}
              />
            )}
          />
        </Card.Content>
      </Card>

      <Card style={glassCardStyle}>
        <Card.Title title="Medication" />
        <Card.Content style={{ gap: 10, overflow: "visible" }}>
          <View style={{ position: "relative", zIndex: 20 }}>
            <Controller
              control={control}
              name="drugName"
              render={({ field: { onChange, value } }) => (
                <TextInput
                  label="Drug name"
                  value={value ?? ""}
                  onChangeText={(text) => {
                    onChange(text);
                    setDrugQuery(text);
                    setSelectedDrug(null);
                    setSelectedDrugCode(null);
                    setSelectedDrugCodes([]);
                    setPmCacheStatus("idle");
                    setPmCacheMessage(null);
                    setPmCounts({ ok: 0, noPdf: 0, fail: 0, total: 0 });
                    setHasSearchResult(false);
                    if (text.trim().length >= 2) {
                      setShowSuggestions(true);
                    } else {
                      setShowSuggestions(false);
                      setSuggestions([]);
                    }
                  }}
                  onFocus={() => {
                    if (!selectedDrug && drugQuery.trim().length >= 2) {
                      setShowSuggestions(true);
                    }
                  }}
                  outlineStyle={{ borderRadius: 16 }}
                  mode="outlined"
                  placeholder="Search Health Canada DPD"
                  right={
                    isSearching ? (
                      <TextInput.Icon icon="progress-clock" />
                    ) : undefined
                  }
                />
              )}
            />

            {showSuggestions ? (
              <Surface
                style={{
                  position: "absolute",
                  top: 64,
                  left: 0,
                  right: 0,
                  borderRadius: 16,
                  backgroundColor: "rgba(27,29,35,0.95)",
                  borderColor: "rgba(255,255,255,0.10)",
                  borderWidth: 1,
                  overflow: "hidden",
                  maxHeight: 240,
                  elevation: 5,
                  zIndex: 30,
                }}
              >
                {isSearching ? (
                  <View style={{ paddingVertical: 14, paddingHorizontal: 16 }}>
                    <ActivityIndicator size="small" />
                    <Text
                      style={{ marginTop: 8, color: "rgba(255,255,255,0.78)" }}
                    >
                      Loading suggestions...
                    </Text>
                  </View>
                ) : suggestions.length > 0 ? (
                  <ScrollView
                    nestedScrollEnabled
                    keyboardShouldPersistTaps="always"
                    showsVerticalScrollIndicator
                    style={{ maxHeight: 240 }}
                  >
                    {suggestions.map((item, index) => (
                      <List.Item
                        key={`${item.brand_name}-${item.drug_code ?? "none"}-${index}`}
                        title={item.brand_name ?? "Unknown"}
                        onPress={() => onSelectSuggestion(item)}
                      />
                    ))}
                  </ScrollView>
                ) : hasSearchResult ? (
                  <List.Item title="No matches" />
                ) : null}
              </Surface>
            ) : null}
          </View>

          {selectedDrug ? (
            <Text
              variant="bodySmall"
              style={{ color: "rgba(255,255,255,0.65)" }}
            >
              Selected: {selectedDrug.brand_name}{" "}
              {pmCacheStatus === "loading" ? "• Preparing monograph..." : null}
              {pmCacheStatus === "ok" ? "• Monograph ready" : null}
              {pmCacheStatus === "no_pdf" ? "• No monograph" : null}
            </Text>
          ) : null}
          {pmCacheMessage ? (
            <Text
              variant="bodySmall"
              style={{ color: "rgba(255,255,255,0.55)" }}
            >
              {pmCacheMessage}
            </Text>
          ) : null}

          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Controller
                control={control}
                name="lastDoseMg"
                render={({ field: { onChange, value } }) => (
                  <TextInput
                    label="Last dose (mg)"
                    value={value ?? ""}
                    onChangeText={onChange}
                    outlineStyle={{ borderRadius: 16 }}
                    mode="outlined"
                    keyboardType="decimal-pad"
                  />
                )}
              />
            </View>

            <View style={{ flex: 1 }}>
              <Button
                mode="outlined"
                icon="calendar-clock"
                onPress={openDatePicker}
                contentStyle={{ height: 56 }}
                style={{ justifyContent: "center" }}
              >
                {formatLastTaken(lastTakenDate)}
              </Button>
            </View>
          </View>

          {showDatePicker && NativeDateTimePicker ? (
            <NativeDateTimePicker
              mode="date"
              display={Platform.OS === "ios" ? "spinner" : "default"}
              value={lastTakenDate ?? new Date()}
              onChange={onDateChange}
            />
          ) : null}

          {showTimePicker && NativeDateTimePicker ? (
            <NativeDateTimePicker
              mode="time"
              display={Platform.OS === "ios" ? "spinner" : "default"}
              value={lastTakenDate ?? new Date()}
              onChange={onTimeChange}
            />
          ) : null}

          {Platform.OS === "ios" && lastTakenDate ? (
            <Button mode="text" onPress={() => setShowTimePicker(true)}>
              Edit time
            </Button>
          ) : null}

          <Controller
            control={control}
            name="notes"
            render={({ field: { onChange, value } }) => (
              <TextInput
                label="Additional comments"
                value={value ?? ""}
                onChangeText={onChange}
                outlineStyle={{ borderRadius: 16 }}
                mode="outlined"
                multiline
                numberOfLines={4}
              />
            )}
          />
        </Card.Content>
      </Card>

      <Card style={glassCardStyle}>
        <Card.Title title="Result" />
        <Card.Content style={{ gap: 10 }}>
          <Text style={{ color: "rgba(255,255,255,0.85)" }}>
            Suggested next dose: {result?.suggestedNextDoseMg ?? "-"} mg
          </Text>
          <Text style={{ color: "rgba(255,255,255,0.85)" }}>
            Interval: {result?.timeIntervalHours ?? "-"} hours
          </Text>
          <Text style={{ color: "rgba(255,255,255,0.85)" }}>
            Next eligible at: {formatIsoOrDash(result?.nextEligibleAt ?? null)}
          </Text>
          {patientSpecificNotes ? (
            <Text style={{ color: "rgba(255,255,255,0.85)" }}>
              Patient-specific notes: {patientSpecificNotes}
            </Text>
          ) : null}

          {aiLoading && (
            <Text style={{ marginTop: 10, color: "rgba(255,255,255,0.85)" }}>
              Calculating...
            </Text>
          )}
          {aiSummary && (
            <View style={{ marginTop: 12 }}>
              <Text
                style={{ fontWeight: "600", color: "rgba(255,255,255,0.92)" }}
              >
                AI Explanation
              </Text>
              <Text style={{ color: "rgba(255,255,255,0.86)" }}>
                {aiSummary}
              </Text>
            </View>
          )}

          <Divider style={{ marginVertical: 8 }} />

          <Text variant="bodySmall" style={{ color: "rgba(255,255,255,0.5)" }}>
            Demo only - not medical advice.
          </Text>
        </Card.Content>
      </Card>

      <Button
        mode="contained"
        onPress={handleSubmit(onSubmit)}
        loading={isSubmitting}
        disabled={isSubmitting || pmCacheStatus === "loading"}
      >
        Calculate
      </Button>

      <Button
        mode="text"
        onPress={() => {
          reset(defaultFormValues);
          setResult(null);
          setAiSummary(null);
          setAiLoading(false);
          setSuggestions([]);
          setShowSuggestions(false);
          setHasSearchResult(false);
          setSelectedDrug(null);
          setSelectedDrugCode(null);
          setSelectedDrugCodes([]);
          setPmCacheStatus("idle");
          setPmCacheMessage(null);
          setPmCounts({ ok: 0, noPdf: 0, fail: 0, total: 0 });
          setLastTakenDate(null);
          setShowDatePicker(false);
          setShowTimePicker(false);
          setDrugQuery("");
          setPatientSpecificNotes(null);
        }}
      >
        Reset
      </Button>

      <Snackbar
        visible={snack.visible}
        onDismiss={() => setSnack({ visible: false, text: "" })}
        duration={3000}
      >
        {snack.text}
      </Snackbar>
    </ScrollView>
  );
}
