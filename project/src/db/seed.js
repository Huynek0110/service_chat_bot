import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { logger } from '../services/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = resolve(__dirname, '../../data/app.db');

const sampleProducts = [
  {
    sku: 'TSHIRT-001',
    name: 'Áo thun nam cơ bản',
    description: 'Áo thun cotton 100% form chuẩn, co giãn tốt, thấm hút mồ hôi. Phù hợp mặc hàng ngày, đi làm, đi học.',
    price: 199000,
    stock_quantity: 50,
    category: 'Áo thun',
    image_url: '',
    is_active: 1
  },
  {
    sku: 'TSHIRT-002',
    name: 'Áo thun nữ oversize',
    description: 'Áo thun form rộng oversize trendy, vải cotton cao cấp mềm mịn. Có nhiều màu sắc: trắng, đen, be, xanh pastel.',
    price: 229000,
    stock_quantity: 35,
    category: 'Áo thun',
    image_url: '',
    is_active: 1
  },
  {
    sku: 'TSHIRT-003',
    name: 'Áo thun couple đồng phục',
    description: 'Bộ 2 áo thun couple cùng mẫu, in hình đẹp độc quyền. Vải cotton 2 chiều cao cấp, bền màu, không xù lông.',
    price: 399000,
    stock_quantity: 20,
    category: 'Áo thun',
    image_url: '',
    is_active: 1
  },
  {
    sku: 'HOODIE-001',
    name: 'Hoodie nam nữ unisex',
    description: 'Hoodie nỉ cotton dày dặn, giữ nhiệt tốt. Có mũ trùm đầu, túi kangaroo phía trước. Form chuẩn unisex.',
    price: 449000,
    stock_quantity: 25,
    category: 'Hoodie',
    image_url: '',
    is_active: 1
  },
  {
    sku: 'HOODIE-002',
    name: 'Hoodie zipper có khóa',
    description: 'Hoodie dạng áo khoác có khóa zipper, tiện lợi mặc cài hoặc mở. Vải nỉ 2 lớp, giữ nhiệt cực tốt cho mùa đông.',
    price: 499000,
    stock_quantity: 15,
    category: 'Hoodie',
    image_url: '',
    is_active: 1
  },
  {
    sku: 'JEANS-001',
    name: 'Quần jean nam straight fit',
    description: 'Quần jean form straight fit cổ điển, vải denim cao cấp co giãn 4 chiều. Thoải mái vận động, bền đẹp theo thời gian.',
    price: 599000,
    stock_quantity: 30,
    category: 'Quần jean',
    image_url: '',
    is_active: 1
  },
  {
    sku: 'JEANS-002',
    name: 'Quần jean nữ skinny',
    description: 'Quần jean skinny ôm sát, tôn dáng. Vải denim co giãn siêu êm, không bị bó khi ngồi. Có nhiều size từ S-XXL.',
    price: 549000,
    stock_quantity: 28,
    category: 'Quần jean',
    image_url: '',
    is_active: 1
  },
  {
    sku: 'SHIRT-001',
    name: 'Áo sơ mi nam công sở',
    description: 'Áo sơ mi vải kate cao cấp, không nhăn, dễ ủi. Form slim fit chuẩn nam giới. Phù hợp đi làm, gặp đối tác.',
    price: 349000,
    stock_quantity: 40,
    category: 'Áo sơ mi',
    image_url: '',
    is_active: 1
  },
  {
    sku: 'SHIRT-002',
    name: 'Áo sơ mi nữ tay lỡ',
    description: 'Áo sơ mi nữ tay lỡ nhẹ nhàng, vải voan mềm mại. Thiết kế nữ tính, phù hợp đi làm, dạo phố.',
    price: 299000,
    stock_quantity: 22,
    category: 'Áo sơ mi',
    image_url: '',
    is_active: 1
  },
  {
    sku: 'SHORTS-001',
    name: 'Quần short kaki nam',
    description: 'Quần short kaki vải cotton thoáng mát, form regular fit. Có 2 túi trước, 2 túi sau. Phù hợp mùa hè, đi chơi.',
    price: 249000,
    stock_quantity: 45,
    category: 'Quần short',
    image_url: '',
    is_active: 1
  }
];

const sampleFaqs = [
  {
    question: 'Shop có đổi trả không?',
    answer: 'Shop hỗ trợ đổi trả trong vòng 7 ngày nếu sản phẩm lỗi, sai size, sai mẫu so với mô tả. Sản phẩm phải còn mới, chưa giặt, còn tem mác nguyên vẹn. Phí ship đổi trả do shop chịu nếu lỗi từ shop.'
  },
  {
    question: 'Ship hàng mất bao lâu?',
    answer: 'Nội thành phố: 1-2 ngày. Ngoại thành: 2-4 ngày. Tỉnh xa: 3-5 ngày. Shop giao hàng qua GHTK, J&T, Viettel Post. Khách có thể check đơn hàng qua mã vận đơn.'
  },
  {
    question: 'Có ship COD không?',
    answer: 'Có, shop hỗ trợ thanh toán khi nhận hàng (COD) toàn quốc. Khách kiểm tra hàng trước khi thanh toán. Lưu ý: một số khu vực xa có thể yêu cầu đặt cọc 10-20% giá trị đơn hàng.'
  },
  {
    question: 'Cách chọn size áo thun?',
    answer: 'Khách vui lòng đo ngực, vai, chiều dài người rồi so sánh với bảng size trên từng sản phẩm. Nếu giữa 2 size, khuyên nên chọn size lớn hơn để thoải mái. Shop tư vấn size miễn phí qua chat.'
  },
  {
    question: 'Áo có xù lông, phai màu không?',
    answer: 'Sản phẩm shop dùng vải cotton cao cấp, đã qua xử lý chống xù lông, chống phai màu. Vệ sinh theo hướng dẫn: giặt máy túi lưới, nước lạnh, không dùng tẩy trắng, phơi ngửa tránh nắng gắt.'
  },
  {
    question: 'Có giảm giá cho khách mua số lượng lớn không?',
    answer: 'Có, mua từ 5 sản phẩm trở lên giảm 5%, từ 10 sản phẩm giảm 10%, từ 20 sản phẩm giảm 15%. Áp dụng cho đơn hàng cùng lúc, liên hệ shop để được báo giá chính xác.'
  },
  {
    question: 'Làm sao để biết hàng còn không?',
    answer: 'Trên website/app luôn cập nhật tồn kho real-time. Hoặc khách chat trực tiếp với bot/nhân viên để check stock tức thì theo SKU hoặc tên sản phẩm.'
  },
  {
    question: 'Shop có showroom trực tiếp không?',
    answer: 'Hiện tại shop chỉ bán online. Khách có thể xem video review, hình ảnh chi tiết, bảng size chuẩn. Hỗ trợ đổi trả 7 ngày nên khách yên tâm đặt hàng.'
  }
];

export async function seed() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  // Load sqlite-vec extension (kb_vectors delete requires vec0 module)
  sqliteVec.load(db);

  try {
    // Clear existing data
    db.exec('DELETE FROM products');
    db.exec('DELETE FROM faqs');
    db.exec('DELETE FROM kb_chunks');
    db.exec('DELETE FROM kb_vectors');
    logger.info('Cleared existing data');
    
    // Insert products
    const insertProduct = db.prepare(`
      INSERT INTO products (sku, name, description, price, stock_quantity, category, image_url, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    for (const p of sampleProducts) {
      insertProduct.run(p.sku, p.name, p.description, p.price, p.stock_quantity, p.category, p.image_url, p.is_active);
    }
    logger.info(`Seeded ${sampleProducts.length} products`);
    
    // Insert FAQs
    const insertFaq = db.prepare(`
      INSERT INTO faqs (question, answer)
      VALUES (?, ?)
    `);
    
    for (const f of sampleFaqs) {
      insertFaq.run(f.question, f.answer);
    }
    logger.info(`Seeded ${sampleFaqs.length} FAQs`);
    
    logger.info('Seed completed successfully');
    
  } catch (error) {
    logger.error('Seed failed', { error: error.message, stack: error.stack });
    throw error;
  } finally {
    db.close();
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('db/seed.js')) {
  seed()
    .then(() => {
      logger.info('Seed completed');
      process.exit(0);
    })
    .catch((err) => {
      logger.error('Seed failed', { error: err.message });
      process.exit(1);
    });
}