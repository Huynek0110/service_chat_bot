import { config } from '../config.js';
import { logger } from '../services/logger.js';

const TAVILY_API_URL = 'https://api.tavily.com/search';
const SEARCH_TIMEOUT_MS = 15000;

// Provider interface: mọi provider phải implement search(query) -> { answer, results: [{title,url,content}] }
// Thêm provider mới (Brave/Exa/SearXNG) chỉ cần viết class mới + thêm 1 nhánh trong getSearchProvider().

export class TavilySearchProvider {
  constructor(apiKey) {
    if (!apiKey) throw new Error('Tavily API key is required');
    this.apiKey = apiKey;
  }

  async search(query) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const response = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          search_depth: 'basic',
          include_answer: true,
          include_raw_content: false,
          max_results: 5
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Tavily API error ${response.status}: ${body.substring(0, 200)}`);
      }

      const data = await response.json();
      return {
        answer: data.answer || '',
        results: (data.results || []).map((r) => ({
          title: r.title || '',
          url: r.url || '',
          content: (r.content || '').substring(0, 500)
        }))
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function getSearchProvider() {
  if (!config.enableWebSearch || !config.webSearchApiKey) return null;
  const name = (config.webSearchProvider || 'tavily').toLowerCase();
  switch (name) {
    case 'tavily':
      return new TavilySearchProvider(config.webSearchApiKey);
    default:
      throw new Error(`Unknown WEB_SEARCH_PROVIDER: ${name} (supported: tavily)`);
  }
}

export async function webSearch({ query }) {
  if (!config.enableWebSearch || !config.webSearchApiKey) {
    return {
      error: 'Web search is disabled. Set ENABLE_WEB_SEARCH=true and WEB_SEARCH_API_KEY in .env'
    };
  }
  if (!query || typeof query !== 'string' || !query.trim()) {
    return { error: 'Missing required search query' };
  }

  try {
    const provider = getSearchProvider();
    const { answer, results } = await provider.search(query.trim());
    logger.info('WEB_SEARCH', { query: query.substring(0, 80), resultsCount: results.length });
    return { answer, results };
  } catch (error) {
    // Sanitized for the model: detail stays only in the server logs.
    logger.error('Web search failed', { error: error.message, query });
    return { error: 'Web search failed, please try again' };
  }
}

export function getWebSearchToolDefinition() {
  if (!config.enableWebSearch || !config.webSearchApiKey) {
    return null;
  }

  return {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Tìm kiếm thông tin trên internet. CHỈ gọi khi TẤT CẢ đúng: (1) câu hỏi về tin tức/thời tiết/kiến thức chung NGOÀI phạm vi shop, (2) dữ liệu cửa hàng và FAQ không trả lời được, (3) khách thật sự cần thông tin đó. TUYỆT ĐỐI KHÔNG gọi cho: giá, tồn kho, sản phẩm, chính sách/đổi trả/ship của shop (dùng DB và tool nội bộ). Thông tin web chỉ bổ sung, không bao giờ ghi đè dữ liệu cửa hàng.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Từ khóa tìm kiếm trên web' }
        },
        required: ['query']
      }
    }
  };
}
