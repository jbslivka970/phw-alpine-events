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

interface AiInviteRuntimeStatus {
  preferredProvider: 'azure-openai' | 'openai' | 'fallback';
  azureConfigured: boolean;
  openAiConfigured: boolean;
  hasAnyProviderConfigured: boolean;
  azureEndpointHost: string | null;
  azureDeployment: string | null;
  azureApiVersion: string;
  openAiModel: string;
  timeoutMs: number;
  issues: string[];
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

function getAiInviteRuntimeStatus(): AiInviteRuntimeStatus {
  const endpoint = process.env['AZURE_OPENAI_ENDPOINT']?.trim() || '';
  const apiKey = process.env['AZURE_OPENAI_API_KEY']?.trim() || '';
  const deployment = process.env['AZURE_OPENAI_DEPLOYMENT']?.trim() || '';
  const apiVersion = process.env['AZURE_OPENAI_API_VERSION']?.trim() || AZURE_OPENAI_API_VERSION;
  const openAiKey = process.env['OPENAI_API_KEY']?.trim() || '';
  const openAiModel = process.env['OPENAI_MODEL']?.trim() || 'gpt-4.1-mini';

  const azureConfigured = Boolean(endpoint && apiKey && deployment);
  const openAiConfigured = Boolean(openAiKey);
  const preferredProvider = azureConfigured
    ? 'azure-openai'
    : openAiConfigured
      ? 'openai'
      : 'fallback';

  let azureEndpointHost: string | null = null;
  if (endpoint) {
    try {
      azureEndpointHost = new URL(endpoint).host;
    } catch {
      azureEndpointHost = null;
    }
  }

  const issues: string[] = [];
  if (!azureConfigured) {
    const missingAzure = [
      !endpoint ? 'AZURE_OPENAI_ENDPOINT' : null,
      !apiKey ? 'AZURE_OPENAI_API_KEY' : null,
      !deployment ? 'AZURE_OPENAI_DEPLOYMENT' : null,
    ].filter((value): value is string => Boolean(value));
    if (missingAzure.length > 0) {
      issues.push(`Missing Azure OpenAI settings: ${missingAzure.join(', ')}`);
    }
  }
  if (!openAiConfigured) {
    issues.push('OPENAI_API_KEY is not configured.');
  }

  return {
    preferredProvider,
    azureConfigured,
    openAiConfigured,
    hasAnyProviderConfigured: azureConfigured || openAiConfigured,
    azureEndpointHost,
    azureDeployment: deployment || null,
    azureApiVersion: apiVersion,
    openAiModel,
    timeoutMs: OPENAI_TIMEOUT_MS,
    issues,
  };
}

function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeParagraphs(paragraphs: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const paragraph of paragraphs) {
    const normalized = normalizeForComparison(paragraph);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(paragraph.trim());
  }
  return unique;
}

function cleanDescriptionForInvite(description: string | null | undefined, input: { eventTitle: string; eventDate?: string | null; location?: string | null }): string {
  const raw = description?.trim();
  if (!raw) {
    return '';
  }

  const titleKey = normalizeForComparison(input.eventTitle);
  const dateKey = input.eventDate ? normalizeForComparison(formatEventDate(input.eventDate)) : '';
  const locationKey = input.location?.trim() ? normalizeForComparison(input.location) : '';

  const paragraphs = raw
    .split(/\n\s*\n/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const filtered = paragraphs.filter((paragraph) => {
    const normalized = normalizeForComparison(paragraph);
    const hasTitle = titleKey.length > 0 && normalized.includes(titleKey);
    const hasDate = dateKey.length > 0 && normalized.includes(dateKey);
    const hasLocation = locationKey.length > 0 && normalized.includes(locationKey);
    const leadIn = /^(join us|you'?re invited|welcome\b|hello\b)/i.test(paragraph);

    // Drop description paragraphs that duplicate invite lead-ins with title/date/location.
    return !(leadIn && hasTitle && (hasDate || hasLocation));
  });

  return dedupeParagraphs(filtered).join('\n\n');
}

function mentionsVeterans(text: string): boolean {
  return /\bveteran(s)?\b|\bmilitary\b|\bservice\b/i.test(text);
}

function mentionsRsvp(text: string): boolean {
  return /\brsvp\b|\bregister\b|\bsign up\b/i.test(text);
}

function formatEventDateNarrative(value: string | null | undefined): string {
  if (!value) {
    return 'Date and time TBD';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Date and time TBD';
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: (process.env['PROGRAM_TIMEZONE']?.trim() || process.env['APP_TIMEZONE']?.trim() || 'America/Denver'),
    timeZoneName: 'short',
  }).formatToParts(parsed);

  const byType = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = byType('weekday');
  const month = byType('month');
  const day = byType('day');
  const year = byType('year');
  const hour = byType('hour');
  const minute = byType('minute');
  const dayPeriod = byType('dayPeriod').toLowerCase() === 'pm' ? 'p.m.' : 'a.m.';
  const zone = byType('timeZoneName');

  return `${weekday}, ${month} ${day}, ${year} | ${hour}:${minute} ${dayPeriod}${zone ? ` ${zone}` : ''}`;
}

function formatEventDate(value: string): string {
  return formatInProgramTimeZone(value);
}

function buildFallbackDraft(input: InviteDraftInput): InviteDraftOutput {
  const dateLabel = formatEventDate(input.eventDate);
  const locationLabel = input.location?.trim() || 'TBD';
  const leadLine = input.eventLeadName?.trim() ? `Coordinator: ${input.eventLeadName.trim()}` : '';
  const cleanedDescription = cleanDescriptionForInvite(input.description, {
    eventTitle: input.eventTitle,
    eventDate: input.eventDate,
    location: input.location,
  });

  const sections: string[] = [
    'Hello PHW Alpine members and veterans,',
    `Join us for ${input.eventTitle} on ${dateLabel} at ${locationLabel}.`,
  ];

  if (cleanedDescription) {
    sections.push(cleanedDescription);
  } else {
    sections.push('We are planning a welcoming outing with strong on-site support for everyone attending.');
  }

  if (!mentionsVeterans(cleanedDescription)) {
    sections.push('This event is part of our mission to serve military veterans through meaningful time outdoors and community connection.');
  }

  sections.push('Please RSVP so we can finalize staffing, gear coordination, and on-site flow.');

  if (leadLine) {
    sections.push(leadLine);
  }

  sections.push('Thank you for supporting Project Healing Waters Alpine.');

  return {
    subject: `You're invited: ${input.eventTitle}`,
    emailBody: sections.join('\n\n'),
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
  const leadLabel = input.eventLeadName?.trim() || 'PHW Alpine team';
  const cleaned = cleanDescriptionForInvite(input.description, {
    eventTitle: input.eventTitle,
    eventDate: input.eventDate,
    location: input.location,
  }) || input.description.trim();
  const eventTitle = input.eventTitle.trim() || 'Upcoming PHW Alpine Event';
  const narrativeDate = formatEventDateNarrative(input.eventDate);
  const locationSentence = input.location?.trim()
    ? `We are partnering around ${input.location.trim()} for a day on the water focused on connection, confidence, and time outdoors together.`
    : 'We are building this outing around connection, confidence, and time outdoors together.';

  const sections: string[] = [
    eventTitle,
    narrativeDate,
    '',
    cleaned,
    '',
    locationSentence,
  ];

  if (!mentionsVeterans(cleaned)) {
    sections.push('This outing is rooted in the PHW mission: serving military veterans through camaraderie, shared purpose, and meaningful time on the river.');
  }

  if (!mentionsRsvp(cleaned)) {
    sections.push('Please RSVP early so we can ensure guides, volunteers, and logistics are in place for a great experience for everyone.');
  }

  sections.push(`Event coordination support: ${leadLabel}.`);

  const polishedDescription = sections.join('\n\n');

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
      '- avoid repeating the same event title/date/location phrasing across paragraphs',
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
      'Write with a confident, human voice that feels ready to publish.',
      'Avoid generic filler phrases and avoid repeating title/date/location language.',
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
      '- Output structure: title line, date/time line, then 3-4 short paragraphs.',
      '- Keep concrete details from the notes; do not invent logistics.',
      '- Include one clear RSVP encouragement near the end.',
      '- Mention support for military veterans in a natural sentence.',
      '- Add one vivid line about scenery, river experience, or camaraderie when supported by notes.',
      '- Keep it polished but not corporate; avoid cliches and repetitive transitions.',
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

export { generateInviteDraft, generateDescriptionDraft, getAiInviteRuntimeStatus };
export type { InviteDraftInput, InviteDraftOutput, DescriptionPolishInput, DescriptionPolishOutput, AiInviteRuntimeStatus };
