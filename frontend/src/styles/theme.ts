export const colors = {
  forest: {
    950: '#0a1f14',
    900: '#0f2e1e',
    800: '#1a3a2a',
    700: '#24523a',
    600: '#2d5f4d',
    500: '#3a7a5f',
    400: '#4a9a76',
    300: '#6db892',
    200: '#a3d4ba',
    100: '#d1eadd',
    50: '#edf7f1',
  },
  river: {
    900: '#0c2440',
    800: '#1b3a5c',
    700: '#2e6b8a',
    600: '#3a8ab0',
    500: '#4da3cc',
    400: '#72bbd9',
    300: '#a0d4e8',
    200: '#c8e6f3',
    100: '#e6f1fb',
    50: '#f0f7fc',
  },
  golden: {
    900: '#5c3a0a',
    800: '#8a5510',
    700: '#b06e28',
    600: '#d4883a',
    500: '#e09a4d',
    400: '#eab26e',
    300: '#f0c894',
    200: '#f5ddb8',
    100: '#faeeda',
    50: '#fdf6ec',
  },
  alpine: {
    900: '#501313',
    800: '#791f1f',
    700: '#a32d2d',
    600: '#c0392b',
    500: '#d94f43',
    400: '#e67369',
    300: '#f09595',
    200: '#f7c1c1',
    100: '#fcebeb',
    50: '#fef5f5',
  },
  slate: {
    950: '#1a1a1a',
    900: '#2c2c2a',
    800: '#3d3d3a',
    700: '#5f5e5a',
    600: '#73726c',
    500: '#888780',
    400: '#9c9a92',
    300: '#b4b2a9',
    200: '#d3d1c7',
    100: '#e8e6dc',
    50: '#f5f4f0',
  },
} as const;

export const gradients = {
  heroBanner: 'linear-gradient(135deg, #1a3a2a 0%, #1b3a5c 40%, #2d5f4d 100%)',
  navbar: 'linear-gradient(90deg, #0f2e1e 0%, #1a3a2a 100%)',
} as const;

export const capacityColors = {
  available: colors.forest[600],
  limited: colors.golden[600],
  full: colors.alpine[600],
} as const;

export const rsvpStyles = {
  yes: { bg: `${colors.forest[600]}18`, text: colors.forest[600], label: 'Going' },
  maybe: { bg: `${colors.golden[600]}18`, text: colors.golden[700], label: 'Maybe' },
  no: { bg: `${colors.slate[400]}18`, text: colors.slate[600], label: "Can't go" },
  waitlist: { bg: `${colors.river[500]}18`, text: colors.river[700], label: 'Waitlisted' },
} as const;

export const fonts = {
  display: '"Libre Baskerville", Georgia, serif',
  body: '"Source Sans 3", system-ui, -apple-system, sans-serif',
} as const;
