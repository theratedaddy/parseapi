require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// CORS
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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const RATE_DADDY_ASSISTANT_ID = 'asst_R55kgv1l6zAQsmuCgYCDpj8k';

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ParseAPI is running' });
});

// Test DB
app.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase.from('parsed_invoices').select('id').limit(1);
    if (error) return res.status(500).json({ success: false, error });
    res.json({ success: true, message: 'Database connected' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// CHAT ENDPOINT
// ==========================================
app.post('/chat', async (req, res) => {
  try {
    const { message, threadId, userId, isLoggedIn } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'No message provided' });
    }

    console.log('[/chat] Message:', message);
    console.log('[/chat] Thread:', threadId || 'new');
    console.log('[/chat] User:', userId || 'anonymous');
    console.log('[/chat] Logged in:', isLoggedIn);

    let thread;
    if (threadId) {
      thread = { id: threadId };
    } else {
      thread = await openai.beta.threads.create();
      console.log('[/chat] Created new thread:', thread.id);
    }

    const contextPrefix = isLoggedIn 
      ? `[SYSTEM CONTEXT: User is logged in. user_id: ${userId}. Dashboard mode.]\n\n`
      : `[SYSTEM CONTEXT: User is NOT logged in. Landing page mode.]\n\n`;

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: contextPrefix + message
    });

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: RATE_DADDY_ASSISTANT_ID
    });

    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    let attempts = 0;
    const maxAttempts = 60;

    while (runStatus.status !== 'completed' && attempts < maxAttempts) {
      if (runStatus.status === 'failed' || runStatus.status === 'cancelled') {
        return res.status(500).json({ error: 'Assistant run failed', status: runStatus.status });
      }

      if (runStatus.status === 'requires_action') {
        const toolCalls = runStatus.required_action?.submit_tool_outputs?.tool_calls;
        
        if (toolCalls) {
          const toolOutputs = [];

          for (const toolCall of toolCalls) {
            console.log('[/chat] Tool call:', toolCall.function.name);
            const args = JSON.parse(toolCall.function.arguments);

            if (toolCall.function.name === 'search_invoices') {
              const result = await searchInvoices(args.user_id || userId, args.query, args.filters);
              toolOutputs.push({ tool_call_id: toolCall.id, output: JSON.stringify(result) });
            } else if (toolCall.function.name === 'get_invoice_details') {
              const result = await getInvoiceDetails(args.user_id || userId, args.invoice_id);
              toolOutputs.push({ tool_call_id: toolCall.id, output: JSON.stringify(result) });
            } else if (toolCall.function.name === 'get_savings_summary') {
              const result = await getSavingsSummary(args.user_id || userId, args.date_range);
              toolOutputs.push({ tool_call_id: toolCall.id, output: JSON.stringify(result) });
            }
          }

          await openai.beta.threads.runs.submitToolOutputs(thread.id, run.id, { tool_outputs: toolOutputs });
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      attempts++;
    }

    if (attempts >= maxAttempts) {
      return res.status(500).json({ error: 'Assistant timed out' });
    }

    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantMessage = messages.data.find(m => m.role === 'assistant');

    if (!assistantMessage) {
      return res.status(500).json({ error: 'No response from assistant' });
    }

    const responseText = assistantMessage.content[0]?.text?.value || '';

    // Log the conversation to Supabase
    await supabase.from('chat_logs').insert({
      user_id: userId || null,
      thread_id: thread.id,
      user_message: message,
      assistant_response: responseText,
      is_logged_in: isLoggedIn || false,
      mode: isLoggedIn ? 'dashboard' : 'landing'
    });

    res.json({
      success: true,
      response: responseText,
      threadId: thread.id
    });

  } catch (error) {
    console.error('[/chat] Error:', error);
    res.status(500).json({ error: 'Chat failed', message: error.message });
  }
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================
async function searchInvoices(userId, query, filters = {}) {
  try {
    if (!userId) return { error: 'User not logged in', invoices: [] };

    let dbQuery = supabase
      .from('parsed_invoices')
      .select('id, vendor_name, invoice_number, invoice_date, po_number, job_site, customer_name, rental_subtotal, freight, fees_total, tax, total, fee_percentage, equipment')
      .eq('user_id', userId)
      .order('invoice_date', { ascending: false });

    if (filters.vendor) dbQuery = dbQuery.ilike('vendor_name', `%${filters.vendor}%`);
    if (filters.date_from) dbQuery = dbQuery.gte('invoice_date', filters.date_from);
    if (filters.date_to) dbQuery = dbQuery.lte('invoice_date', filters.date_to);
    if (query) dbQuery = dbQuery.or(`invoice_number.ilike.%${query}%,po_number.ilike.%${query}%,job_site.ilike.%${query}%,vendor_name.ilike.%${query}%,customer_name.ilike.%${query}%`);

    const { data, error } = await dbQuery.limit(10);
    if (error) return { error: error.message, invoices: [] };
    return { invoices: data || [] };
  } catch (err) {
    return { error: err.message, invoices: [] };
  }
}

async function getInvoiceDetails(userId, invoiceId) {
  try {
    if (!userId) return { error: 'User not logged in' };
    const { data, error } = await supabase
      .from('parsed_invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('user_id', userId)
      .single();
    if (error) return { error: error.message };
    return { invoice: data };
  } catch (err) {
    return { error: err.message };
  }
}

async function getSavingsSummary(userId, dateRange = {}) {
  try {
    if (!userId) return { error: 'User not logged in' };

    let query = supabase
      .from('parsed_invoices')
      .select('id, invoice_date, vendor_name, market_savings, fee_percentage, fees_total, rental_subtotal')
      .eq('user_id', userId);

    if (dateRange.from) query = query.gte('invoice_date', dateRange.from);
    if (dateRange.to) query = query.lte('invoice_date', dateRange.to);

    const { data, error } = await query;
    if (error) return { error: error.message };

    const totalInvoices = data?.length || 0;
    const totalMarketSavings = data?.reduce((sum, inv) => sum + (parseFloat(inv.market_savings) || 0), 0) || 0;
    const totalFees = data?.reduce((sum, inv) => sum + (parseFloat(inv.fees_total) || 0), 0) || 0;
    const totalRental = data?.reduce((sum, inv) => sum + (parseFloat(inv.rental_subtotal) || 0), 0) || 0;
    const avgFeePercentage = totalRental > 0 ? (totalFees / totalRental) * 100 : 0;

    const topSavings = data?.filter(inv => inv.market_savings > 0)?.sort((a, b) => b.market_savings - a.market_savings)?.slice(0, 5) || [];

    return {
      summary: {
        total_invoices: totalInvoices,
        total_potential_savings: totalMarketSavings.toFixed(2),
        total_fees_paid: totalFees.toFixed(2),
        total_rental_spend: totalRental.toFixed(2),
        average_fee_percentage: avgFeePercentage.toFixed(1)
      },
      top_savings_opportunities: topSavings
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ==========================================
// SEARCH INVOICES ENDPOINT
// ==========================================
app.post('/search-invoices', async (req, res) => {
  try {
    const { userId, query, filters } = req.body;
    if (!userId) return res.status(401).json({ error: 'User ID required' });
    const result = await searchInvoices(userId, query, filters);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// PARSE ENDPOINTS
// ==========================================
function calculateExpectedAmount(dayRate, weekRate, fourWeekRate, rentalDays) {
  const day = parseFloat(dayRate) || 0;
  const week = parseFloat(weekRate) || 0;
  const month = parseFloat(fourWeekRate) || 0;
  const days = parseInt(rentalDays) || 1;
  
  if (day === 0 && week === 0 && month === 0) return 0;
  
  const effectiveDay = day || (week / 5) || (month / 20);
  const effectiveWeek = week || (day * 5) || (month / 4);
  const effectiveMonth = month || (week * 4) || (day * 20);
  
  if (days <= 2) return effectiveDay * days;
  if (days <= 6) return Math.min(effectiveDay * days, effectiveWeek);
  if (days <= 27) return Math.min(effectiveDay * days, effectiveWeek * Math.ceil(days / 7), effectiveMonth);
  return Math.min(effectiveMonth * Math.ceil(days / 28), effectiveWeek * Math.ceil(days / 7));
}

app.post('/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const base64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `You are an invoice parser for construction equipment rentals. Extract the following from this invoice and return ONLY valid JSON, no other text:
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
}` },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
        ]
      }],
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
    res.status(500).json({ error: 'Failed to process invoice', message: error.message });
  }
});

app.post('/parse-base64', async (req, res) => {
  try {
    const { base64Image, mimeType, userId } = req.body;
    if (!base64Image) return res.status(400).json({ error: 'No image provided' });
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `You are an expert invoice parser for construction equipment rentals. Extract ALL charges from this invoice.

===========================================
CRITICAL: SCAN THE ENTIRE INVOICE LINE BY LINE
===========================================
Read every single line item on this invoice. Do not skip any charges.

===========================================
EQUIPMENT & METER CHARGES
===========================================
For each piece of equipment, extract:
- description, serial_number, day_rate, week_rate, four_week_rate, rental_days, amount

IMPORTANT - METER CHARGES: Look for "Meter chg", "Meter charge", "Hour meter", "Meter out/in" on equipment lines.
If you see "Meter chg: $X" or similar on an equipment line, that is a METER OVERAGE charge.
Add ALL meter charges together and put in "meter_charges" field.

Example: "Meter out: 679.20 Meter in: 695.20 Meter chg: 1,350.53" → meter_charges: 1350.53

===========================================
FREIGHT / DELIVERY / PICKUP
===========================================
Add together ALL of these and put the TOTAL in "freight":
- DELIVERY CHARGE, DELIVERY FEE, DELIVERY
- PICKUP CHARGE, PICKUP FEE, PICK UP, PICK-UP
- FREIGHT, FREIGHT CHARGE
- HAULING, CARTAGE, TRUCKING
- MOBILIZATION, DEMOBILIZATION, MOB/DEMOB

Example: DELIVERY CHARGE $220 + PICKUP CHARGE $220 = freight: 440

===========================================
FEES - PUT IN "fees" OBJECT
===========================================
FUEL CHARGES → fees.fuel_surcharge:
- REFUELING SERVICE CHARGE
- REFUEL CHARGE
- FUEL SURCHARGE
- FUEL SERVICE
- DSL (diesel fuel)

ENVIRONMENTAL → fees.environmental:
- ENVIRONMENTAL SERVICE CHARGE
- ENV CHARGE
- ENVIRONMENTAL FEE

RENTAL PROTECTION → fees.rental_protection:
- RENTAL PROTECTION
- DAMAGE WAIVER
- LDW
- PHYSICAL DAMAGE WAIVER
- PDW
- EQUIPMENT PROTECTION

ADMIN/OTHER → fees.admin_fee or fees.other:
- ADMIN FEE
- SERVICE FEE
- PROCESSING FEE

TRANSPORT SURCHARGE → fees.transport_surcharge:
- TRANS SRVC SURCHARGE
- TRANSPORT SURCHARGE
- TRANSPORTATION SURCHARGE
(This is different from delivery/freight - it's a percentage surcharge)

===========================================
TAXES - DO NOT PUT IN FEES
===========================================
These are TAXES, not fees. Add them to the "tax" field:
- SALES TAX
- STATE TAX
- PROPERTY TAX (like "TX UNIT PROPERTY TAX")
- DIESEL TAX (like "TEXAS DIESEL TAX")
- Any line with "TAX" in the name

===========================================
RENTAL SUBTOTAL
===========================================
This is ONLY the equipment rental charges. 
Look for "Rental Subtotal" on the invoice.
DO NOT include fees, freight, tax, fuel, or meter charges.

===========================================
RETURN THIS JSON
===========================================
{
  "vendor": "Company name",
  "invoice_number": "Invoice number",
  "invoice_date": "YYYY-MM-DD",
  "po_number": "PO or null",
  "customer_name": "Customer name",
  "job_site": "Job site or null",
  "equipment": [
    {
      "description": "Equipment description",
      "serial_number": "Serial or null",
      "day_rate": 0.00,
      "week_rate": 0.00,
      "four_week_rate": 0.00,
      "rental_days": 1,
      "amount": 0.00
    }
  ],
  "rental_subtotal": 0.00,
  "freight": 0.00,
  "meter_charges": 0.00,
  "fees": {
    "fuel_surcharge": 0.00,
    "environmental": 0.00,
    "rental_protection": 0.00,
    "transport_surcharge": 0.00,
    "admin_fee": 0.00,
    "other": 0.00
  },
  "tax": 0.00,
  "total": 0.00,
  "confidence": "high"
}

Return ONLY valid JSON. No markdown. No explanation.` },
          { type: 'image_url', image_url: { url: `data:${mimeType || 'image/png'};base64,${base64Image}` } }
        ]
      }],
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
    
    const rentalSubtotal = parseFloat(parsed.rental_subtotal) || 0;
    const freightKeywords = ['delivery', 'pickup', 'pick up', 'pick-up', 'freight', 'hauling', 'mobilization', 'demobilization', 'cartage', 'transport', 'trucking', 'inbound', 'outbound', 'drayage'];
    let extractedFreight = parseFloat(parsed.freight) || 0;
    let remainingFees = {};
    
    if (parsed.fees && typeof parsed.fees === 'object') {
      for (const [feeName, feeAmount] of Object.entries(parsed.fees)) {
        const lowerName = feeName.toLowerCase();
        const amount = parseFloat(feeAmount) || 0;
        const isFreight = freightKeywords.some(kw => lowerName.includes(kw)) && !lowerName.includes('surcharge');
        if (isFreight && amount > 0) {
          extractedFreight += amount;
        } else {
          remainingFees[feeName] = feeAmount;
        }
      }
    }
    
    const freight = extractedFreight;
    const meterCharges = parseFloat(parsed.meter_charges) || 0;
    const flaggedCharges = parsed.flagged_charges || {};
    const feesTotal = Object.values(remainingFees).reduce((sum, f) => sum + (parseFloat(f) || 0), 0);
    const feePercentage = rentalSubtotal > 0 ? (feesTotal / rentalSubtotal) * 100 : 0;
    
    const rentalKeywords = ['herc', 'sunbelt', 'united rentals', 'ohio cat', 'admar', 'skyworks', 'caterpillar', 'rental', 'leppo'];
    const vendorLower = (parsed.vendor || '').toLowerCase();
    const isRental = rentalKeywords.some(kw => vendorLower.includes(kw));
    
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
      freight: freight || null,
      freight_total: freight || null,
      meter_charges: meterCharges > 0 ? meterCharges : null,
      flagged_charges: Object.keys(flaggedCharges).length > 0 ? flaggedCharges : null,
      fees_total: feesTotal || null,
      tax: parseFloat(parsed.tax) || null,
      total: parseFloat(parsed.total) || null,
      fees: remainingFees || {},
      equipment: parsed.equipment || [],
      fee_percentage: feePercentage || null,
      confidence: parsed.confidence || null,
      raw_response: parsed || {}
    }).select().single();
    
    if (insertError || !insertData || !insertData.id) {
      return res.status(500).json({ success: false, error: 'Failed to insert invoice', details: insertError });
    }
    
    const invoiceId = insertData.id;
    let totalMarketSavings = 0;
    const equipmentWithRates = [];
    
    if (parsed.equipment && parsed.equipment.length > 0) {
      for (const item of parsed.equipment) {
        const rentalDays = parseInt(item.rental_days) || 1;
        let actualAmount = parseFloat(item.amount) || 0;
        
        if (actualAmount === 0) {
          actualAmount = calculateExpectedAmount(item.day_rate, item.week_rate, item.four_week_rate, rentalDays);
        }
        
        if (!item.description || actualAmount === 0) continue;
        
        try {
          const { data: classifyData } = await supabase.rpc('classify_equipment', { p_description: item.description });
          
          if (classifyData && classifyData.length > 0) {
            const classified = classifyData[0];
            const { data: savingsData } = await supabase.rpc('calculate_savings', {
              p_equipment_class: classified.equipment_class,
              p_equipment_size: classified.equipment_size,
              p_actual_amount: actualAmount,
              p_rental_days: rentalDays,
              p_region: 'Cleveland'
            });
            
            if (savingsData && savingsData.length > 0) {
              const savings = savingsData[0];
              totalMarketSavings += parseFloat(savings.total_overpaid) || 0;
              
              equipmentWithRates.push({
                ...item,
                calculated_amount: actualAmount,
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
              
              await supabase.from('equipment_rates').insert({
                invoice_id: invoiceId,
                user_id: userId || null,
                equipment_description: item.description,
                equipment_class: classified.equipment_class,
                equipment_size: classified.equipment_size,
                day_rate: item.day_rate || null,
                week_rate: item.week_rate || null,
                four_week_rate: item.four_week_rate || null,
                rental_days: rentalDays,
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
    }
    
    await supabase
      .from('parsed_invoices')
      .update({ market_savings: totalMarketSavings, equipment_with_rates: equipmentWithRates })
      .eq('id', invoiceId);
    
    res.json({ 
      success: true, 
      data: {
        ...parsed,
        id: invoiceId,
        freight: freight,
        freight_total: freight,
        meter_charges: meterCharges,
        flagged_charges: flaggedCharges,
        fees: remainingFees,
        fees_total: feesTotal,
        fee_percentage: feePercentage,
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
  console.log('ParseAPI running on port ' + PORT);
});

module.exports = app;