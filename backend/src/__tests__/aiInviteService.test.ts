import { generateInviteDraft } from '../services/aiInviteService';

describe('aiInviteService', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('falls back deterministically when no AI provider is configured', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_DEPLOYMENT;

    const draft = await generateInviteDraft({
      eventTitle: 'Casting Clinic',
      eventDate: '2026-06-01T18:00:00.000Z',
      location: 'Boulder Creek',
      description: 'Bring waders',
      tone: 'friendly',
    });

    expect(draft.provider).toBe('fallback');
    expect(draft.subject).toContain('Casting Clinic');
    expect(draft.mapUrl).toContain('google.com/maps/search');
    expect(Array.isArray(draft.imageSuggestions)).toBe(true);
    expect((draft.imageSuggestions ?? []).length).toBeGreaterThan(0);
  });

  it('returns parsed Azure OpenAI JSON when Azure deployment is configured', async () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://phw-openai.openai.azure.com';
    process.env.AZURE_OPENAI_API_KEY = 'azure-test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4.1-mini';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                subject: 'Casting Clinic Invitation',
                email_body: 'Email body',
                sms_body: 'SMS body',
              }),
            },
          },
        ],
      }),
    }) as typeof fetch;

    const draft = await generateInviteDraft({
      eventTitle: 'Casting Clinic',
      eventDate: '2026-06-01T18:00:00.000Z',
      location: 'Boulder Creek',
      description: 'Bring waders',
      tone: 'friendly',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/openai/deployments/gpt-4.1-mini/chat/completions?api-version='),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'api-key': 'azure-test-key',
        }),
      })
    );
    expect(draft).toMatchObject({
      subject: 'Casting Clinic Invitation',
      emailBody: 'Email body',
      smsBody: 'SMS body',
      provider: 'azure-openai',
    });
    expect(draft.mapUrl).toContain('google.com/maps/search');
    expect((draft.imageSuggestions ?? []).length).toBeGreaterThan(0);
  });

  it('returns parsed OpenAI JSON when public OpenAI is configured without Azure OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_DEPLOYMENT;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          subject: 'Casting Clinic Invitation',
          email_body: 'Email body',
          sms_body: 'SMS body',
        }),
      }),
    }) as typeof fetch;

    const draft = await generateInviteDraft({
      eventTitle: 'Casting Clinic',
      eventDate: '2026-06-01T18:00:00.000Z',
      location: 'Boulder Creek',
      description: 'Bring waders',
      tone: 'friendly',
    });

    expect(draft).toMatchObject({
      subject: 'Casting Clinic Invitation',
      emailBody: 'Email body',
      smsBody: 'SMS body',
      provider: 'openai',
    });
    expect(draft.mapUrl).toContain('google.com/maps/search');
    expect((draft.imageSuggestions ?? []).length).toBeGreaterThan(0);
  });

  it('prefers Azure OpenAI when both Azure and public OpenAI credentials are configured', async () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://phw-openai.openai.azure.com';
    process.env.AZURE_OPENAI_API_KEY = 'azure-test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4.1-mini';
    process.env.OPENAI_API_KEY = 'public-test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                subject: 'Azure Preferred',
                email_body: 'Email body',
                sms_body: 'SMS body',
              }),
            },
          },
        ],
      }),
    }) as typeof fetch;

    const draft = await generateInviteDraft({
      eventTitle: 'Casting Clinic',
      eventDate: '2026-06-01T18:00:00.000Z',
      location: 'Boulder Creek',
      description: 'Bring waders',
      tone: 'friendly',
    });

    expect(draft.provider).toBe('azure-openai');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/chat/completions?api-version='),
      expect.any(Object)
    );
  });

  it('falls back when the Azure OpenAI response payload is invalid', async () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://phw-openai.openai.azure.com';
    process.env.AZURE_OPENAI_API_KEY = 'azure-test-key';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4.1-mini';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'not-json' } }] }),
    }) as typeof fetch;

    const draft = await generateInviteDraft({
      eventTitle: 'Casting Clinic',
      eventDate: '2026-06-01T18:00:00.000Z',
      location: 'Boulder Creek',
      description: 'Bring waders',
      tone: 'friendly',
    });

    expect(draft.provider).toBe('fallback');
  });
});