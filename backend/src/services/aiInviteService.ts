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
  provider: 'azure-openai' | 'openai' | 'fallback';
}

interface OpenAiDraftResponse {
  subject?: unknown;
  email_body?: unknown;
  sms_body?: unknown;
}

interface AzureOpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

const OPENAI_TIMEOUT_MS = 12_000;
const MAX_DESCRIPTION_PROMPT_LENGTH = 1_500;
const AZURE_OPENAI_API_VERSION = '2024-12-01-preview';

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

function parseAzureOpenAiTextPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const choices = (payload as AzureOpenAiChatResponse).choices;
  if (!Array.isArray(choices)) {
    return '';
  }

  for (const choice of choices) {
    const content = choice?.message?.content;
    if (typeof content === 'string' && content.trim().length > 0) {
      return content;
    }
    if (Array.isArray(content)) {
      const joined = content
        .map((item) => (typeof item?.text === 'string' ? item.text : ''))
        .join('')
        .trim();
      if (joined.length > 0) {
        return joined;
      }
    }
  }

  return '';
}

function toInviteDraftFromJson(text: string, provider: 'azure-openai' | 'openai'): InviteDraftOutput | null {
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
      provider,
    };
  } catch {
    return null;
  }
}

function buildPrompt(input: InviteDraftInput): { system: string; user: string } {
  const tone = input.tone ?? 'friendly';
  const description = input.description?.trim()
    ? input.description.trim().slice(0, MAX_DESCRIPTION_PROMPT_LENGTH)
    : 'n/a';

  return {
    system: 'You generate concise event invite copy for nonprofit chapter communications. Return only JSON with keys: subject, email_body, sms_body.',
    user: [
      `Tone: ${tone}`,
      `Event title: ${input.eventTitle}`,
      `Event date: ${formatEventDate(input.eventDate)}`,
      `Location: ${input.location ?? 'TBD'}`,
      `Description: ${description}`,
      'Constraints:',
      '- subject <= 90 characters',
      '- sms_body <= 280 characters and include RSVP call-to-action',
      '- no markdown formatting',
    ].join('\n'),
  };
}

async function fetchJsonWithTimeout(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`AI invite generation failed with status ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function generateWithAzureOpenAi(input: InviteDraftInput): Promise<InviteDraftOutput | null> {
  const endpoint = process.env['AZURE_OPENAI_ENDPOINT']?.trim();
  const apiKey = process.env['AZURE_OPENAI_API_KEY']?.trim();
  const deployment = process.env['AZURE_OPENAI_DEPLOYMENT']?.trim();
  const apiVersion = process.env['AZURE_OPENAI_API_VERSION']?.trim() || AZURE_OPENAI_API_VERSION;

  if (!endpoint || !apiKey || !deployment) {
    return null;
  }

  const prompt = buildPrompt(input);
  const normalizedEndpoint = endpoint.replace(/\/$/, '');
  const url = `${normalizedEndpoint}/openai/deployments/${deployment}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  const payload = {
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    max_tokens: 450,
    temperature: 0.4,
    response_format: { type: 'json_object' },
  };

  const data = await fetchJsonWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  const text = parseAzureOpenAiTextPayload(data);
  const draft = toInviteDraftFromJson(text, 'azure-openai');
  if (!draft) {
    throw new Error('Azure OpenAI response did not contain valid invite JSON');
  }

  return draft;
}

async function generateWithPublicOpenAi(input: InviteDraftInput): Promise<InviteDraftOutput | null> {
  const apiKey = process.env['OPENAI_API_KEY'];
  const model = process.env['OPENAI_MODEL'] ?? 'gpt-4.1-mini';

  if (!apiKey) {
    return null;
  }

  const prompt = buildPrompt(input);
  const payload = {
    model,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: prompt.system,
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt.user,
          },
        ],
      },
    ],
    max_output_tokens: 450,
  };

  const data = await fetchJsonWithTimeout('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const text = parseOpenAiTextPayload(data);
  const draft = toInviteDraftFromJson(text, 'openai');
  if (!draft) {
    throw new Error('OpenAI response did not contain valid invite JSON');
  }

  return draft;
}

async function generateInviteDraft(input: InviteDraftInput): Promise<InviteDraftOutput> {
  try {
    const azureDraft = await generateWithAzureOpenAi(input);
    if (azureDraft) {
      return azureDraft;
    }

    const publicDraft = await generateWithPublicOpenAi(input);
    if (publicDraft) {
      return publicDraft;
    }

    return buildFallbackDraft(input);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn('[aiInviteService] AI invite generation timed out. Falling back to deterministic invite draft.');
      return buildFallbackDraft(input);
    }
    console.warn('[aiInviteService] Falling back to deterministic invite draft.', error);
    return buildFallbackDraft(input);
  }
}

export { generateInviteDraft };
export type { InviteDraftInput, InviteDraftOutput };
