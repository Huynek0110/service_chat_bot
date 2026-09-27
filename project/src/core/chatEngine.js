import { config } from '../config.js';
import { chatCompletion } from '../llm/client.js';
import { loadSystemPrompt } from './systemPrompt.js';
import { getHistory, saveMessage, getMessageCount } from './history.js';
import { retrieveFormatted } from '../rag/retriever.js';
import { searchProducts, checkStock, requestHumanHandoff } from '../tools/index.js';
import { webSearch, getWebSearchToolDefinition } from '../tools/webSearch.js';
import { getDb } from '../db/migrate.js';
import { createOrder } from '../orders/orders.js';
import { countAccLines } from '../orders/stock.js';
import { logger, logError } from '../services/logger.js';

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_products',
      description: 'Tìm kiếm sản phẩm theo từ khóa và danh mục',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Từ khóa tìm kiếm (tên, mô tả)' },
          category: { type: 'string', description: 'Danh mục sản phẩm (tùy chọn)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_stock',
      description: 'Kiểm tra tồn kho thực tế của sản phẩm theo SKU hoặc tên',
      parameters: {
        type: 'object',
        properties: {
          sku_or_name: { type: 'string', description: 'SKU hoặc tên sản phẩm' }
        },
        required: ['sku_or_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_order',
      description: 'Chỉ gọi khi khách đã xác nhận muốn MUA một sản phẩm cụ thể (muốn đặt hàng/thanh toán). Không bao giờ dùng cho câu hỏi xem hàng/giá/tồn kho.',
      parameters: {
        type: 'object',
        properties: {
          sku_or_name: { type: 'string', description: 'SKU hoặc tên sản phẩm khách muốn mua' }
        },
        required: ['sku_or_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'request_human',
      description: 'Yêu cầu chuyển cho nhân viên thật khi khách cần hỗ trợ đặc biệt',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Lý do chuyển (khiếu nại, hỏi phức tạp, yêu cầu người thật...)' }
        },
        required: ['reason']
      }
    }
  }
];

// Conditionally add web_search tool if enabled (Tavily API key configured)
const _webSearchDef = getWebSearchToolDefinition();
if (_webSearchDef) {
  TOOL_DEFINITIONS.push(_webSearchDef);
}

// Escape %, _ and \ for LIKE ... ESCAPE '\' searches (mirrors src/tools/index.js).
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

async function executeTool(name, args, context) {
  const startTime = Date.now();
  
  try {
    let result;
    
    switch (name) {
      case 'search_products':
        result = await searchProducts(args);
        break;
      case 'check_stock':
        result = await checkStock(args);
        break;
      case 'request_human':
        result = await requestHumanHandoff(args, context);
        break;
      case 'create_order': {
        try {
          const skuOrName = args?.sku_or_name;
          if (!skuOrName || typeof skuOrName !== 'string' || skuOrName.trim().length === 0) {
            result = { error: 'Thiếu tên/SKU sản phẩm để tạo đơn.' };
            break;
          }
          const db = getDb();
          // Mirror checkStock lookup: exact SKU first, then name-LIKE.
          let product = db.prepare(`
            SELECT id, sku, name, price, acc_file
            FROM products
            WHERE sku = ? AND is_active = 1
          `).get(skuOrName);
          if (!product) {
            product = db.prepare(`
              SELECT id, sku, name, price, acc_file
              FROM products
              WHERE name LIKE ? ESCAPE '\\' AND is_active = 1
              ORDER BY id ASC
              LIMIT 1
            `).get(`%${escapeLike(skuOrName)}%`);
          }
          if (!product) {
            result = { error: `Không tìm thấy sản phẩm "${skuOrName}" trong cửa hàng.` };
            break;
          }
          if (product.acc_file) {
            let remaining = 0;
            try {
              remaining = countAccLines(product.acc_file);
            } catch {
              remaining = 0;
            }
            if (remaining === 0) {
              result = { error: 'Sản phẩm này vừa hết hàng acc, xin lỗi bạn' };
              break;
            }
          }
          const order = createOrder({ channel: context?.channel, userId: context?.userId, productId: product.id });
          result = {
            ok: true,
            order_id: order.id,
            order_code: order.order_code,
            product_name: product.name,
            price: product.price,
            formattedPrice: product.price.toLocaleString('vi-VN') + 'đ'
          };
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        break;
      }
      case 'web_search':
        result = await webSearch(args);
        break;
      default:
        result = { error: `Unknown tool: ${name}` };
    }
    
    const duration = Date.now() - startTime;
    logger.info('TOOL_CALL', {
      category: 'tool_call',
      tool: name,
      args,
      result: typeof result === 'object' ? JSON.stringify(result).substring(0, 500) : result,
      durationMs: duration,
      userId: context?.userId,
      channel: context?.channel
    });
    
    return result;
  } catch (error) {
    logError(`Tool execution failed: ${name}`, error);
    return { error: error.message };
  }
}

function buildMessages(systemPrompt, ragContext, history, userMessage) {
  const messages = [
    { role: 'system', content: systemPrompt }
  ];
  
  if (ragContext) {
    messages.push({
      role: 'system',
      content: `THÔNG TIN THAM KHẢO TỪ CƠ SỞ DỮ LIỆU CỬA HÀNG:\n${ragContext}`
    });
  }
  
  for (const msg of history) {
    messages.push({ role: msg.role, content: msg.content });
  }
  
  messages.push({ role: 'user', content: userMessage });
  
  return messages;
}

// Rebuild the assistant turn in the OpenAI shape instead of replaying the raw
// response message: the runtime may add fields (reasoning traces, ids) that
// strict servers reject, and `arguments` must go back as a JSON string.
function buildAssistantTurn(content, toolCalls) {
  const turn = { role: 'assistant', content: content || '' };
  if (toolCalls.length > 0) {
    turn.tool_calls = toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) }
    }));
  }
  return turn;
}

export async function handleIncomingMessage({ channel, userId, text, eventId, metadata }) {
  const startTime = Date.now();
  
  try {
    const systemPrompt = loadSystemPrompt();
    // History, message count (both local SQLite) and RAG embedding (network)
    // are independent — run together instead of sequentially. RAG resolves to
    // null when no embedding model is configured, so the bot chats regardless.
    const [history, messageCount, ragContext] = await Promise.all([
      getHistory(channel, userId, config.maxHistoryMessages),
      getMessageCount(channel, userId),
      retrieveFormatted(text, config.ragTopK),
    ]);
    const isFirstMessage = messageCount === 0;

    if (isFirstMessage && config.botDisclosureMessage) {
      await saveMessage(channel, userId, 'assistant', config.botDisclosureMessage);
    }
    await saveMessage(channel, userId, 'user', text);

    const messages = buildMessages(systemPrompt, ragContext, history, text);
    
    let finalResponse = '';
    let iterations = 0;
    const maxIterations = 5;
    
    while (iterations < maxIterations) {
      iterations++;

      const response = await chatCompletion({
        messages,
        tools: TOOL_DEFINITIONS,
        temperature: config.llmTemperature,
        maxTokens: config.llmMaxTokens,
        think: config.llmThink
      });

      const assistantContent = response.content || '';
      const toolCalls = response.toolCalls;

      messages.push(buildAssistantTurn(assistantContent, toolCalls));

      // Plain text where tool calls were expected is a valid answer.
      if (toolCalls.length === 0) {
        finalResponse = assistantContent;
        break;
      }

      for (const toolCall of toolCalls) {
        const result = await executeTool(toolCall.name, toolCall.arguments, { channel, userId, eventId });

        // tool_call_id is mandatory: the model matches the result to its request.
        // Tool context is per-turn only and is not persisted to history.
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }
    }

    if (!finalResponse) {
      finalResponse = config.fallbackErrorMessage;
    }

    if (isFirstMessage && config.botDisclosureMessage && finalResponse) {
      finalResponse = config.botDisclosureMessage + '\n' + finalResponse;
    }

    if (finalResponse) {
      await saveMessage(channel, userId, 'assistant', finalResponse);
    }
    
    const duration = Date.now() - startTime;
    logger.info('CHAT_COMPLETE', {
      channel,
      userId,
      durationMs: duration,
      iterations,
      responseLength: finalResponse.length
    });
    
    return finalResponse;
    
  } catch (error) {
    logError('handleIncomingMessage failed', error);
    return config.fallbackErrorMessage;
  }
}

export async function testConnection() {
  try {
    await chatCompletion({
      messages: [{ role: 'user', content: 'Test' }],
      temperature: 0,
      maxTokens: 8
    });
    return { success: true, model: config.lmStudioChatModel };
  } catch (error) {
    return { success: false, error: error.message };
  }
}