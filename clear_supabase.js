import dotenv from 'dotenv';
dotenv.config();

async function clearSupabase() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = (process.env.SUPABASE_URL || '').replace('https://', '').split('.')[0];

  console.log('Fetching table list...');
  const getTablesSql = `
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
  `;

  const tablesRes = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: getTablesSql })
  });

  const tablesData = await tablesRes.json();
  const tableNames = tablesData.map(t => `public."${t.table_name}"`).join(', ');

  console.log('Tables to truncate:', tableNames);

  const truncateSql = `
    TRUNCATE TABLE ${tableNames} RESTART IDENTITY CASCADE;
    DELETE FROM auth.users;
  `;

  console.log('Executing TRUNCATE and DELETE operations...');
  const clearRes = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: truncateSql })
  });

  const clearData = await clearRes.json();
  console.log('Truncate response:', clearData);

  // Verify row counts for all tables
  console.log('\n--- Verifying empty tables ---');
  let countSql = tablesData.map(t => `SELECT '${t.table_name}' as table_name, COUNT(*) as row_count FROM public."${t.table_name}"`).join(' UNION ALL ');
  
  const countRes = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: countSql })
  });

  const counts = await countRes.json();
  console.log('Row Counts after fresh start:');
  console.table(counts);
}

clearSupabase().catch(console.error);
