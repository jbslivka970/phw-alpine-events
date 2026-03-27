interface InviteDraftInput {
  eventTitle: string;
  eventDate: string;
  location?: string | null;
  description?: string | null;
  tone?: 'friendly' | 'professional';
}

interface InviteDraftOutput {
  subject: string;
  emailBody: string;
  smsBody: string;
  provider: 'openai' | 'fallback';
}

interface OpenAiDraftResponse {
  subject?: unknown;
  email_body?: unknown;
  sms_body?: unknown;
}

function formatEventDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function buildFallbackDraft(input: InviteDraftInput): InviteDraftOutput {
  const dateLabel = formatEventDate(input.eventDate);
  const locationLabel = input.location?.trim() || 'TBD';
  const descriptionLine = input.description?.trim()
    ? `\n\nDetails:\n${input.description.trim()}`
    : '';

  return {
    subject: `You're invited: ${input.eventTitle}`,
    emailBody: `Hello PHW Alpine members,\n\nYou're invited to ${input.eventTitle} on ${dateLabel} at ${locationLabel}. Please RSVP to help us plan staffing and equipment.${descriptionLine}\n\nTight lines,\nPHW Alpine Team`,
    smsBody: `PHW Alpine: ${input.eventTitle} on ${dateLabel} at ${locationLabel}. Please RSVP in the app. Reply STOP to opt out.`,
    provider: 'fallback',
  };
}

function parseOpenAiTextPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const objectPayload = payload as { output?: unknown[]; output_text?: unknown };
  if (typeof objectPayload.output_text === 'string') {
    return objectPayload.output_text;
  }

  if (!Array.isArray(objectPayload.output)) {
    return '';
  }

  for (const entry of objectPayload.output) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const content = (entry as { content?: unknown[] }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const item of content) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const text = (item as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim().length > 0) {
        return text;
      }
    }
  }

  return '';
}

function toInviteDraftFromJson(text: string): InviteDraftOutput | null {
  try {
    const parsed = JSON.parse(text) as OpenAiDraftResponse;
    if (
      typeof parsed.subject !== 'string'
      || typeof parsed.email_body !== 'string'
      || typeof parsed.sms_body !== 'string'
    ) {
      return null;
    }

    return {
      subject: parsed.subject.trim(),
      emailBody: parsed.email_body.trim(),
      smsBody: parsed.sms_body.trim(),
      provider: 'openai',
    };
  } catch {
    return null;
  }
}

async function generateInviteDraft(input: InviteDraftInput): Promise<InviteDraftOutput> {
  const apiKey = process.env['OPENAI_API_KEY'];
  const model = process.env['OPENAI_MODEL'] ?? 'gpt-4.1-mini';

  if (!apiKey) {
    return buildFallbackDraft(input);
  }

  const tone = input.tone ?? 'friendly';
  const payload = {
    model,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: 'You generate concise event invite copy for nonprofit chapter communications. Return only JSON with keys: subject, email_body, sms_body.',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              `Tone: ${tone}`,
              `Event title: ${input.eventTitle}`,
              `Event date: ${formatEventDate(input.eventDate)}`,
              `Location: ${input.location ?? 'TBD'}`,
              `Description: ${input.description ?? 'n/a'}`,
              'Constraints:',
              '- subject <= 90 characters',
              '- sms_body <= 280 characters and include RSVP call-to-action',
              '- no markdown formatting',
            ].join('\n'),
          },
        ],
      },
    ],
    max_output_tokens: 450,
  };

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`OpenAI invite generation failed with status ${response.status}`);
    }

    const data = await response.json();
    const text = parseOpenAiTextPayload(data);
    const draft = toInviteDraftFromJson(text);
    if (!draft) {
      throw new Error('OpenAI response did not contain valid invite JSON');
    }

    return draft;
  } catch (error) {
    console.warn('[aiInviteService] Falling back to deterministic invite draft.', error);
    return buildFallbackDraft(input);
  }
}

export { generateInviteDraft };
export type { InviteDraftInput, InviteDraftOutput };
