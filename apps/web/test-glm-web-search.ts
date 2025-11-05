/**
 * Test script to verify GLM Web Search API implementation
 * Run with: npx tsx apps/web/test-glm-web-search.ts
 */

const GLM_API_KEY = process.env.GLM_DEFAULT_API_KEY || process.env.GLM_API_KEY;

if (!GLM_API_KEY) {
  console.error('❌ Error: GLM_API_KEY or GLM_DEFAULT_API_KEY environment variable required');
  process.exit(1);
}

console.log('🔍 Testing GLM Web Search API Integration\n');

// Test 1: Direct Web Search API endpoint (corrected per OpenAPI spec)
async function testDirectEndpoint() {
  console.log('📡 Test 1: Direct Web Search API endpoint');
  console.log('Endpoint: https://api.z.ai/api/paas/v4/web_search\n');

  try {
    const response = await fetch('https://api.z.ai/api/paas/v4/web_search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GLM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        search_engine: 'search-prime',
        search_query: 'TypeScript best practices 2025',
        count: 5,
        search_recency_filter: 'oneMonth',
      }),
    });

    console.log('Status:', response.status, response.statusText);

    if (!response.ok) {
      const errorText = await response.text();
      console.log('❌ Error Response:', errorText);
      return false;
    }

    const data = await response.json();
    console.log('✅ Success! Sample result:');
    console.log('- Results count:', data.search_result?.length || 0);
    if (data.search_result?.[0]) {
      console.log('- First result:', data.search_result[0].title);
      console.log('- URL:', data.search_result[0].link);
    }
    return true;
  } catch (error) {
    console.log('❌ Request failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

// Test 2: Chat Completions API with web_search tool (alternative approach)
async function testChatCompletionsWithTool() {
  console.log('\n📡 Test 2: Chat Completions API with web_search tool');
  console.log('Endpoint: https://api.z.ai/api/coding/paas/v4/chat/completions\n');

  try {
    const response = await fetch('https://api.z.ai/api/coding/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GLM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'glm-4-air',
        messages: [
          {
            role: 'user',
            content: 'What are the latest TypeScript best practices in 2025?'
          }
        ],
        tools: [
          {
            type: 'web_search',
            web_search: {
              enable: 'true',
              search_engine: 'search-prime',
              search_result: 'true',
              count: 5,
              search_recency_filter: 'oneMonth',
            }
          }
        ]
      }),
    });

    console.log('Status:', response.status, response.statusText);

    if (!response.ok) {
      const errorText = await response.text();
      console.log('❌ Error Response:', errorText);
      return false;
    }

    const data = await response.json();
    console.log('✅ Success!');
    console.log('- Response structure:', Object.keys(data));
    console.log('- Has web_search results:', !!data.web_search);
    if (data.web_search) {
      console.log('- Web search results count:', data.web_search.length || 0);
      if (data.web_search[0]) {
        console.log('- First result:', data.web_search[0].title || 'N/A');
      }
    }
    return true;
  } catch (error) {
    console.log('❌ Request failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

// Test 3: Alternative endpoint patterns
async function testAlternativeEndpoints() {
  console.log('\n📡 Test 3: Testing alternative endpoint patterns\n');

  const endpoints = [
    'https://api.z.ai/api/web-search',
    'https://api.z.ai/api/v1/web-search',
    'https://api.z.ai/web-search',
    'https://api.z.ai/api/tools/web_search', // underscore instead of hyphen
  ];

  for (const endpoint of endpoints) {
    console.log(`Testing: ${endpoint}`);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GLM_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          search_engine: 'search-prime',
          search_query: 'test',
          count: 1,
        }),
      });

      console.log(`  Status: ${response.status} ${response.statusText}`);

      if (response.ok) {
        console.log('  ✅ This endpoint works!');
        return endpoint;
      }
    } catch (error) {
      console.log(`  ❌ Failed:`, error instanceof Error ? error.message : error);
    }
  }

  return null;
}

// Run all tests
async function runTests() {
  console.log('=' .repeat(60));
  console.log('GLM Web Search API Test Suite');
  console.log('=' .repeat(60) + '\n');

  const test1Success = await testDirectEndpoint();
  const test2Success = await testChatCompletionsWithTool();

  console.log('\n' + '=' .repeat(60));
  console.log('Test Summary:');
  console.log('=' .repeat(60));
  console.log(`Test 1 (Direct endpoint): ${test1Success ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`Test 2 (Chat with tool):  ${test2Success ? '✅ PASSED' : '❌ FAILED'}`);

  if (!test1Success && !test2Success) {
    console.log('\n🔍 Both approaches failed. Testing alternative endpoints...');
    const workingEndpoint = await testAlternativeEndpoints();

    if (workingEndpoint) {
      console.log(`\n✅ Found working endpoint: ${workingEndpoint}`);
    } else {
      console.log('\n❌ No working endpoints found.');
      console.log('\n💡 Recommendations:');
      console.log('1. Check GLM API documentation for correct endpoint');
      console.log('2. Verify API key has web search permissions');
      console.log('3. Contact GLM support for endpoint details');
    }
  } else if (test2Success && !test1Success) {
    console.log('\n💡 Recommendation: Use Chat Completions API with web_search tool');
    console.log('   Current implementation may need to be refactored.');
  } else if (test1Success) {
    console.log('\n✅ Direct endpoint works! Current implementation is correct.');
  }

  console.log('\n' + '=' .repeat(60) + '\n');
}

runTests().catch(console.error);
