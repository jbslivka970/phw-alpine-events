import { formatInProgramTimeZone } from '../utils/dateTime';

interface InviteDraftInput {
  eventTitle: string;
  eventDate: string;
  location?: string | null;
  description?: string | null;
  eventLeadName?: string | null;
  tone?: 'friendly' | 'professional' | 'casual' | 'exciting';
}

interface InviteDraftOutput {
  subject: string;
  emailBody: string;
  smsBody: string;
  provider: 'azure-openai' | 'openai' | 'fallback';
  mapUrl?: string | null;
  imageSuggestions?: string[];
}

interface DescriptionPolishInput {
  eventTitle: string;
  eventDate?: string | null;
  location?: string | null;
  description: string;
  eventLeadName?: string | null;
  tone?: 'friendly' | 'professional' | 'casual' | 'exciting';
}

interface DescriptionPolishOutput {
  polishedDescription: string;
  provider: 'azure-openai' | 'openai' | 'fallback';
}

interface OpenAiDraftResponse {
  subject?: unknown;
  email_body?: unknown;
  sms_body?: unknown;
}

interface OpenAiDescriptionResponse {
  polished_description?: unknown;
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
  return formatInProgramTimeZone(value);
}

function buildFallbackDraft(input: InviteDraftInput): InviteDraftOutput {
  const dateLabel = formatEventDate(input.eventDate);
  const locationLabel = input.location?.trim() || 'TBD';
  const leadLine = input.eventLeadName?.trim() ? `\n\nCoordinator: ${input.eventLeadName.trim()}` : '';
  const descriptionLine = input.description?.trim()
    ? `\n\nWhat to expect:\n${input.description.trim()}`
    : '';

  return {
    subject: `You're invited: ${input.eventTitle}`,
    emailBody: `Hello PHW Alpine members and veterans,\n\nJoin us for ${input.eventTitle} on ${dateLabel} at ${locationLabel}. We are building this event to be welcoming, well-supported, and mission-focused for our veteran community.${descriptionLine}${leadLine}\n\nPlease RSVP so we can finalize staffing, gear coordination, and on-site flow for everyone.\n\nThank you for supporting Project Healing Waters Alpine.`,
    smsBody: `PHW Alpine: ${input.eventTitle} on ${dateLabel} at ${locationLabel}. Please RSVP in the app. Reply STOP to opt out.`,
    provider: 'fallback',
    mapUrl: buildMapUrl(input.location),
    imageSuggestions: buildImageSuggestions(input),
  };
}

function buildMapUrl(location?: string | null): string | null {
  const normalized = location?.trim();
  if (!normalized) {
    return null;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(normalized)}`;
}

function buildFallbackDescription(input: DescriptionPolishInput): DescriptionPolishOutput {
  const eventLabel = input.eventTitle.trim() || 'this event';
  const dateLabel = input.eventDate ? formatEventDate(input.eventDate) : 'TBD';
  const locationLabel = input.location?.trim() || 'TBD';
  const leadLabel = input.eventLeadName?.trim() || 'PHW Alpine team';
  const polishedDescription = [
    `Join us for ${eventLabel} on ${dateLabel} at ${locationLabel}.`,
    '',
    input.description.trim(),
    '',
    `This outing is designed to create a welcoming, mission-focused experience for veterans, with support from ${leadLabel}. Please RSVP early so we can finalize staffing and logistics.`,
  ].join('\n');

  return {
    polishedDescription,
    provider: 'fallback',
  };
}

function buildImageSuggestions(input: InviteDraftInput): string[] {
  const location = input.location?.trim();
  const terms = [
    'fly fishing mountain river',
    'veterans outdoors fly fishing',
  ];

  if (location) {
    terms.unshift(`fly fishing ${location}`);
  }

  return terms.slice(0, 3).map((term) => `https://www.pexels.com/search/${encodeURIComponent(term)}/`);
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

function toDescriptionPolishFromJson(text: string, provider: 'azure-openai' | 'openai'): DescriptionPolishOutput | null {
  try {
    const parsed = JSON.parse(text) as OpenAiDescriptionResponse;
    if (typeof parsed.polished_description !== 'string') {
      return null;
    }

    const polishedDescription = parsed.polished_description.trim();
    if (!polishedDescription) {
      return null;
    }

    return {
      polishedDescription,
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
  const lead = input.eventLeadName?.trim() || 'n/a';

  return {
    system: [
      'You generate concise event invite copy for nonprofit program communications.',
      'Tone must match the requested style and still be polished, modern, and clear.',
      'Treat the provided description as rough notes and rewrite it into compelling, publication-ready copy.',
      'Do not just append a tag line to the provided description.',
      'Produce a fresh draft with a clear hook, concrete details, and a strong RSVP call-to-action.',
      'Return only JSON with keys: subject, email_body, sms_body.',
      'Do not use markdown. Do not include HTML.',
    ].join(' '),
    user: [
      `Tone: ${tone}`,
      `Event title: ${input.eventTitle}`,
      `Event date: ${formatEventDate(input.eventDate)}`,
      `Location: ${input.location ?? 'TBD'}`,
      `Event lead: ${lead}`,
      `Description: ${description}`,
      'Constraints:',
      '- subject <= 90 characters',
      '- sms_body <= 280 characters and include RSVP call-to-action',
      '- email_body should be 2-4 short paragraphs with concise sentence lengths',
      '- include one sentence that reflects support for military veterans',
      '- highlight one specific event detail when available (agenda item, activity, speaker, or location detail)',
      '- include a compelling call-to-action',
      '- no markdown formatting',
    ].join('\n'),
  };
}

function buildDescriptionPrompt(input: DescriptionPolishInput): { system: string; user: string } {
  const tone = input.tone ?? 'friendly';
  const description = input.description.trim().slice(0, MAX_DESCRIPTION_PROMPT_LENGTH);
  const lead = input.eventLeadName?.trim() || 'n/a';

  return {
    system: [
      'You rewrite rough nonprofit event notes into polished event descriptions.',
      'Keep the requested tone while making the writing vivid, clear, and concise.',
      'Return only JSON with key: polished_description.',
      'Do not use markdown or HTML.',
    ].join(' '),
    user: [
      `Tone: ${tone}`,
      `Event title: ${input.eventTitle}`,
      `Event date: ${input.eventDate ? formatEventDate(input.eventDate) : 'n/a'}`,
      `Location: ${input.location ?? 'TBD'}`,
      `Event lead: ${lead}`,
      `Raw description notes: ${description}`,
      'Constraints:',
      '- Produce 2-3 short paragraphs.',
      '- Keep concrete details from the notes; do not invent logistics.',
      '- Include a clear RSVP encouragement.',
      '- Mention support for military veterans in a natural sentence.',
      '- Output only JSON',
    ].join('\n'),
  };
}

function withEnhancements(input: InviteDraftInput, draft: InviteDraftOutput): InviteDraftOutput {
  return {
    ...draft,
    mapUrl: buildMapUrl(input.location),
    imageSuggestions: buildImageSuggestions(input),
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

async function generateDescriptionWithAzureOpenAi(input: DescriptionPolishInput): Promise<DescriptionPolishOutput | null> {
  const endpoint = process.env['AZURE_OPENAI_ENDPOINT']?.trim();
  const apiKey = process.env['AZURE_OPENAI_API_KEY']?.trim();
  const deployment = process.env['AZURE_OPENAI_DEPLOYMENT']?.trim();
  const apiVersion = process.env['AZURE_OPENAI_API_VERSION']?.trim() || AZURE_OPENAI_API_VERSION;

  if (!endpoint || !apiKey || !deployment) {
    return null;
  }

  const prompt = buildDescriptionPrompt(input);
  const normalizedEndpoint = endpoint.replace(/\/$/, '');
  const url = `${normalizedEndpoint}/openai/deployments/${deployment}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  const payload = {
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    max_tokens: 450,
    temperature: 0.45,
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
  const draft = toDescriptionPolishFromJson(text, 'azure-openai');
  if (!draft) {
    throw new Error('Azure OpenAI response did not contain valid description JSON');
  }

  return draft;
}

async function generateDescriptionWithPublicOpenAi(input: DescriptionPolishInput): Promise<DescriptionPolishOutput | null> {
  const apiKey = process.env['OPENAI_API_KEY'];
  const model = process.env['OPENAI_MODEL'] ?? 'gpt-4.1-mini';

  if (!apiKey) {
    return null;
  }

  const prompt = buildDescriptionPrompt(input);
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
  const draft = toDescriptionPolishFromJson(text, 'openai');
  if (!draft) {
    throw new Error('OpenAI response did not contain valid description JSON');
  }

  return draft;
}

async function generateInviteDraft(input: InviteDraftInput): Promise<InviteDraftOutput> {
  try {
    const azureDraft = await generateWithAzureOpenAi(input);
    if (azureDraft) {
      return withEnhancements(input, azureDraft);
    }

    const publicDraft = await generateWithPublicOpenAi(input);
    if (publicDraft) {
      return withEnhancements(input, publicDraft);
    }

    return withEnhancements(input, buildFallbackDraft(input));
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn('[aiInviteService] AI invite generation timed out. Falling back to deterministic invite draft.');
      return withEnhancements(input, buildFallbackDraft(input));
    }
    console.warn('[aiInviteService] Falling back to deterministic invite draft.', error);
    return withEnhancements(input, buildFallbackDraft(input));
  }
}

async function generateDescriptionDraft(input: DescriptionPolishInput): Promise<DescriptionPolishOutput> {
  try {
    const azureDraft = await generateDescriptionWithAzureOpenAi(input);
    if (azureDraft) {
      return azureDraft;
    }

    const publicDraft = await generateDescriptionWithPublicOpenAi(input);
    if (publicDraft) {
      return publicDraft;
    }

    return buildFallbackDescription(input);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn('[aiInviteService] AI description generation timed out. Falling back to deterministic description draft.');
      return buildFallbackDescription(input);
    }
    console.warn('[aiInviteService] Falling back to deterministic description draft.', error);
    return buildFallbackDescription(input);
  }
}

export { generateInviteDraft, generateDescriptionDraft };
export type { InviteDraftInput, InviteDraftOutput, DescriptionPolishInput, DescriptionPolishOutput };
