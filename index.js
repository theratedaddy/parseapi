require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '50mb' }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.get('/', (req, res) => {
  res.json({ status: 'ParseAPI is running' });
});

app.get('/test-db', async (req, res) => {
  try {
    console.log('[/test-db] hit');
    const { data, error } = await supabase
      .from('parsed_invoices')
      .insert({
        source: 'parseapi',
        app_source: 'test',
        vendor_name: 'Test Vendor',
        invoice_number: 'TEST-123',
        total: 100
      });
    console.log('[/test-db] data:', data);
    console.log('[/test-db] error:', error);
    if (error) {
      return res.status(500).json({ success: false, error });
    }
    res.json({ success: true, data });
  } catch (err) {
    console.error('[/test-db] exception:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const base64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are an invoice parser for construction equipment rentals. Extract the following from this invoice and return ONLY valid JSON, no other text:
{
  "vendor": "company name",
  "invoice_number": "invoice number",
  "invoice_date": "YYYY-MM-DD",
  "po_number": "PO number or null",
  "customer_name": "customer name",
  "job_site": "job site or null",
  "equipment": [],
  "rental_subtotal": 0.00,
  "fees": {},
  "tax": 0.00,
  "total": 0.00,
  "confidence": "high/medium/low"
}`
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64}`
              }
            }
          ]
        }
      ],
      max_tokens: 1000
    });
    const content = response.choices[0].message.content;
    let parsed;
    try {
      const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse invoice', raw: content });
    }
    res.json({ success: true, data: parsed });
  } catch (error) {
    console.error('Parse error:', error);
    res.status(500).json({ error: 'Failed to process invoice', message: error.message });
  }
});

app.post('/parse-base64', async (req, res) => {
  try {
    const { base64Image, mimeType, userId } = req.body;
    if (!base64Image) {
      return res.status(400).json({ error: 'No image provided' });
    }
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are an invoice parser for construction equipment rentals. Extract data from this invoice and return ONLY valid JSON.

CRITICAL: Look for the SUMMARY BOX at the bottom of the invoice. Herc Rentals invoices have a summary that shows:
- RENTAL CHARGES (this is rental_subtotal)
- OTHER CHARGES (this is a FEE - includes misc fees, shop supplies, etc)
- RENTAL PROTECTION (this is a FEE - insurance/damage waiver)
- FUEL CHARGES (this is a FEE)
- DELIVERY/PICK UP (this is NOT a fee - it's a service)
- TAXABLE CHARGES
- TAX
- TOTAL CHARGES

WHAT COUNTS AS A FEE (add to fees object):
- OTHER CHARGES (from Herc summary box)
- RENTAL PROTECTION / Insurance / Damage Waiver
- Environmental fee / Emissions fee
- Fuel surcharge / Fuel service charge
- Transportation surcharge (SURCHARGE only, not base delivery)
- Admin fee
- Shop supplies
- Any line item with "surcharge", "fee", "protection", "waiver" in the name

WHAT IS NOT A FEE (goes in delivery_pickup_total):
- DELIVERY/PICK UP (from summary box)
- Delivery charge / Pickup charge
- Freight / Hauling

FOR RENTAL_SUBTOTAL:
- Use "RENTAL CHARGES" from the summary box if available
- This should be the equipment rental amount BEFORE fees, delivery, and tax
- Do NOT use TAXABLE CHARGES (that includes fees)
- Do NOT use TOTAL CHARGES

FOR EQUIPMENT: Extract day_rate if shown. Also try to estimate rental_days from dates or billing period.

{
  "vendor": "Company name (e.g. Herc Rentals, ADMAR, Sunbelt)",
  "invoice_number": "Invoice number",
  "invoice_date": "YYYY-MM-DD format",
  "po_number": "PO number or null",
  "customer_name": "Customer/Bill to name",
  "job_site": "Job site address or null",
  "equipment": [
    {
      "description": "Equipment description",
      "serial_number": "Serial number or null",
      "day_rate": 0.00,
      "week_rate": 0.00,
      "four_week_rate": 0.00,
      "rental_days": 1,
      "amount": 0.00
    }
  ],
  "rental_subtotal": 0.00,
  "delivery_pickup_total": 0.00,
  "fees": {
    "other_charges": 0.00,
    "rental_protection": 0.00,
    "environmental": 0.00,
    "fuel_surcharge": 0.00,
    "transport_surcharge": 0.00
  },
  "tax": 0.00,
  "total": 0.00,
  "confidence": "high"
}

Return ONLY the JSON object, no markdown, no explanation.`
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType || 'image/png'};base64,${base64Image}`
              }
            }
          ]
        }
      ],
      max_tokens: 2000
    });
    const content = response.choices[0].message.content;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        return res.status(500).json({ success: false, error: 'Could not parse OpenAI response as JSON' });
      }
    }
    
    // Calculate fees total (excluding delivery/pickup which are services)
    const feesTotal = parsed.fees ? Object.values(parsed.fees).reduce((sum, f) => sum + (parseFloat(f) || 0), 0) : 0;
    const rentalSubtotal = parseFloat(parsed.rental_subtotal) || 0;
    const feePercentage = rentalSubtotal > 0 ? (feesTotal / rentalSubtotal) * 100 : 0;
    
    const rentalKeywords = ['herc', 'sunbelt', 'united rentals', 'ohio cat', 'admar', 'skyworks', 'caterpillar', 'rental'];
    const vendorLower = (parsed.vendor || '').toLowerCase();
    const isRental = rentalKeywords.some(kw => vendorLower.includes(kw));
    
    // Insert invoice first to get the ID
    const { data: insertData, error: insertError } = await supabase.from('parsed_invoices').insert({
      source: 'parseapi',
      app_source: 'rate_daddy',
      user_id: userId || null,
      invoice_type: isRental ? 'equipment_rental' : 'unknown',
      is_equipment_rental: isRental,
      vendor_name: parsed.vendor || null,
      vendor_normalized: vendorLower.split(' ')[0] || null,
      invoice_number: parsed.invoice_number || null,
      invoice_date: parsed.invoice_date || null,
      po_number: parsed.po_number || null,
      customer_name: parsed.customer_name || null,
      job_site: parsed.job_site || null,
      rental_subtotal: rentalSubtotal || null,
      fees_total: feesTotal || null,
      tax: parseFloat(parsed.tax) || null,
      total: parseFloat(parsed.total) || null,
      fees: parsed.fees || {},
      equipment: parsed.equipment || [],
      fee_percentage: feePercentage || null,
      confidence: parsed.confidence || null,
      raw_response: parsed || {}
    }).select().single();
    
    console.log("INSERT DATA:", insertData);
    console.log("INSERT ERROR:", insertError);
    
    // Process equipment for market rate comparison
    let totalMarketSavings = 0;
    const equipmentWithRates = [];
    
    if (insertData && parsed.equipment && parsed.equipment.length > 0) {
      for (const item of parsed.equipment) {
        if (!item.description) continue;
        
        try {
          // Classify the equipment
          const { data: classifyData } = await supabase.rpc('classify_equipment', {
            p_description: item.description
          });
          
          if (classifyData && classifyData.length > 0) {
            const classified = classifyData[0];
            
            // Calculate savings
            const { data: savingsData } = await supabase.rpc('calculate_savings', {
              p_equipment_class: classified.equipment_class,
              p_equipment_size: classified.equipment_size,
              p_actual_day_rate: item.day_rate,
              p_rental_days: item.rental_days || 1,
              p_region: 'Cleveland'
            });
            
            if (savingsData && savingsData.length > 0) {
              const savings = savingsData[0];
              totalMarketSavings += parseFloat(savings.total_overpaid) || 0;
              
              equipmentWithRates.push({
                ...item,
                equipment_class: classified.equipment_class,
                equipment_size: classified.equipment_size,
                classification_confidence: classified.confidence,
                market_rate_low: savings.market_rate_low,
                market_rate_high: savings.market_rate_high,
                market_rate_avg: savings.market_rate_avg,
                overpaid_per_day: savings.overpaid_per_day,
                total_overpaid: savings.total_overpaid,
                data_source: savings.data_source
              });
              
              // Insert into equipment_rates table
              await supabase.from('equipment_rates').insert({
                invoice_id: insertData.id,
                user_id: userId || null,
                equipment_p_description: item.description,
                equipment_class: classified.equipment_class,
                equipment_size: classified.equipment_size,
                day_rate: item.day_rate,
                week_rate: item.week_rate || null,
                four_week_rate: item.four_week_rate || null,
                rental_days: item.rental_days || 1,
                vendor_name: parsed.vendor,
                region: 'Cleveland',
                invoice_date: parsed.invoice_date
              });
            }
          }
        } catch (err) {
          console.log('Error processing equipment item:', err.message);
        }
      }
      
      // Update invoice with market savings data
      if (totalMarketSavings > 0) {
        await supabase.from('parsed_invoices').update({
          market_savings: totalMarketSavings,
          equipment_with_rates: equipmentWithRates
        }).eq('id', insertData.id);
      }
    }
    
    res.json({ 
      success: true, 
      data: {
        ...parsed,
        market_savings: totalMarketSavings,
        equipment_with_rates: equipmentWithRates
      }, 
      raw_response: content 
    });
  } catch (error) {
    console.error('Parse error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`ParseAPI running on port ${PORT}`);
});