import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {
  try {
    const body = await req.json();

    const {
      patient_name,
      weight_kg,
      age_years,
      gender,
      drug_name,
      last_dose_mg,
      last_dose_time,
      additional_comments,
      suggested_next_dose_mg,
      interval_hours,
      next_eligible_time
    } = body;

    const prompt = `
This is a hackathon demo application.
This is NOT medical advice.

You must NOT generate new dose numbers.
You must NOT modify the provided dose or interval.
You may only explain the provided calculated result.

Patient Profile:
Name: ${patient_name}
Weight: ${weight_kg} kg
Age: ${age_years}
Gender: ${gender}

Medication:
Drug: ${drug_name}
Last Dose: ${last_dose_mg} mg
Last Dose Time: ${last_dose_time}
Indication: ${additional_comments}

Calculated Result:
Next Dose: ${suggested_next_dose_mg} mg
Interval: ${interval_hours} hours
Next Eligible Time: ${next_eligible_time}

Explain:
1. Why this dose is appropriate.
2. Any standard monitoring considerations.
3. Any assumptions made.
End with: "Demo only — not medical advice."
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
      })
    });

    const data = await response.json();

    return new Response(
      JSON.stringify({
        ai_summary: data.choices?.[0]?.message?.content ?? null
      }),
      { headers: { "Content-Type": "application/json" } }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: "AI explanation failed" }),
      { status: 500 }
    );
  }
});
