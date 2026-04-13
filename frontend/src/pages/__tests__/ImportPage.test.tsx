import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importApi } from '../../api/imports';
import { ImportPage } from '../ImportPage';

vi.mock('../../api/imports', () => ({
  importApi: {
    preview: vi.fn(),
    commit: vi.fn(),
    logs: vi.fn(),
    downloadReport: vi.fn(),
  },
}));

const mockedImportApi = importApi as unknown as {
  preview: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  logs: ReturnType<typeof vi.fn>;
  downloadReport: ReturnType<typeof vi.fn>;
};

describe('ImportPage conflict workflow', () => {
  beforeEach(() => {
    mockedImportApi.logs.mockResolvedValue({ logs: [] });
    mockedImportApi.preview.mockResolvedValue({
      sessionId: 'session-1',
      fileName: 'members.csv',
      summary: {
        totalRows: 3,
        newRows: 1,
        updatedRows: 1,
        unchangedRows: 0,
        conflictRows: 1,
        skippedRows: 0,
        errorRows: 0,
      },
      rows: [
        {
          rowNumber: 12,
          action: 'conflict',
          data: {
            rowNumber: 12,
            firstName: 'Casey',
            lastName: 'Walker',
            email: 'shared@example.com',
            mobilePhone: '',
            salutation: '',
            title: '',
            accountName: '',
            smsOptIn: false,
            emailOptOut: false,
            activeVolunteer: false,
            activeParticipant: false,
          },
          conflictMembers: [
            {
              memberId: 'member-1',
              firstName: 'Jordan',
              lastName: 'Walker',
              email: 'shared@example.com',
            },
          ],
          errorMessage: 'Email conflict',
        },
      ],
    });
    mockedImportApi.commit.mockResolvedValue({
      importId: 'import-1',
      summary: {
        totalRows: 3,
        newRows: 2,
        updatedRows: 1,
        unchangedRows: 0,
        conflictRows: 1,
        skippedRows: 0,
        errorRows: 0,
      },
    });
  });

  it('defaults conflict rows to skip and submits selected resolutions', async () => {
    render(<ImportPage />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    const file = new File(['first,last,email\nA,B,a@example.com'], 'members.csv', { type: 'text/csv' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText('Shared Email Conflicts')).toBeInTheDocument();

    const row = screen.getByText('Casey Walker').closest('tr');
    expect(row).toBeTruthy();
    const decisionSelect = within(row as HTMLElement).getByRole('combobox') as HTMLSelectElement;

    expect(decisionSelect.value).toBe('skip');
    await userEvent.selectOptions(decisionSelect, 'create');
    expect(decisionSelect.value).toBe('create');

    await userEvent.click(screen.getByRole('button', { name: 'Confirm Import' }));

    await waitFor(() => {
      expect(mockedImportApi.commit).toHaveBeenCalledWith('session-1', {
        conflictResolutions: {
          '12': 'create',
        },
      });
    });

    expect(await screen.findByText('Import complete!')).toBeInTheDocument();
  });
});
