const sql = require('mssql');

function requireEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function upsertTestMember(pool, firstName, lastName, email) {
  const normalizedEmail = email.trim().toLowerCase();

  const query = `
DECLARE @exists INT = (SELECT COUNT(1) FROM dbo.member WHERE LOWER(email) = @email);

IF @exists = 0
BEGIN
  IF COL_LENGTH('dbo.member', 'is_test_account') IS NULL
  BEGIN
    INSERT INTO dbo.member (first_name, last_name, email, is_active, created_at, updated_at)
    VALUES (@first_name, @last_name, @email, 1, GETUTCDATE(), GETUTCDATE());
  END
  ELSE
  BEGIN
    INSERT INTO dbo.member (first_name, last_name, email, is_active, is_test_account, created_at, updated_at)
    VALUES (@first_name, @last_name, @email, 1, 1, GETUTCDATE(), GETUTCDATE());
  END
END
ELSE
BEGIN
  UPDATE dbo.member
  SET first_name = @first_name,
      last_name = @last_name,
      is_active = 1,
      updated_at = GETUTCDATE()
  WHERE LOWER(email) = @email;

  IF COL_LENGTH('dbo.member', 'is_test_account') IS NOT NULL
  BEGIN
    UPDATE dbo.member
    SET is_test_account = 1,
        updated_at = GETUTCDATE()
    WHERE LOWER(email) = @email;
  END
END;

SELECT TOP 1
  member_id,
  first_name,
  last_name,
  email,
  is_active,
  CASE WHEN COL_LENGTH('dbo.member', 'is_test_account') IS NULL THEN CAST(NULL AS BIT) ELSE is_test_account END AS is_test_account
FROM dbo.member
WHERE LOWER(email) = @email
ORDER BY updated_at DESC;
`;

  const result = await pool
    .request()
    .input('first_name', sql.NVarChar(100), firstName)
    .input('last_name', sql.NVarChar(100), lastName)
    .input('email', sql.NVarChar(320), normalizedEmail)
    .query(query);

  return result.recordset[0];
}

async function main() {
  const config = {
    server: requireEnv('DB_HOST'),
    database: requireEnv('DB_NAME'),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    port: Number.parseInt(process.env.DB_PORT || '1433', 10),
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
    pool: {
      max: 4,
      min: 0,
      idleTimeoutMillis: 15000,
    },
  };

  const targets = [
    { firstName: 'PHW', lastName: 'Smoke Admin', email: 'phw-test-admin@phwalpine.onmicrosoft.com' },
    { firstName: 'PHW', lastName: 'Smoke Creator', email: 'phw-test-eventcreator@phwalpine.onmicrosoft.com' },
  ];

  const pool = new sql.ConnectionPool(config);
  await pool.connect();

  try {
    for (const target of targets) {
      const row = await upsertTestMember(pool, target.firstName, target.lastName, target.email);
      console.log(JSON.stringify({
        seeded: target.email,
        member_id: row?.member_id,
        first_name: row?.first_name,
        last_name: row?.last_name,
        is_active: row?.is_active,
        is_test_account: row?.is_test_account,
      }));
    }
  } finally {
    await pool.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
