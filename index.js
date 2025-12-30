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

const RATE_DADDY_ASSISTANT_ID = 'asst_R55kgv1l6zAQsmuCgYCDpj8k';

function calculateExpectedAmount(dayRate, weekRate, fourWeekRate, rentalDays) {
  const day = parseFloat(dayRate) || 0;
  const week = parseFloat(weekRate) || 0;
  const month = parseFloat(fourWeekRate) || 0;
  const days = parseInt(rentalDays) || 1;
  
  if (day === 0 && week === 0 && month === 0) {
    return 0;
  }
  
  const effectiveDay = day || (week / 5) || (month / 20);
  const effectiveWeek = week || (day * 5) || (month / 4);
  const effectiveMonth = month || (week * 4) || (day * 20);
  
  if (days <= 2) {
    return effectiveDay * days;
  } else if (days <= 6) {
    return Math.min(effectiveDay * days, effectiveWeek);
  } else if (days <= 27) {
    return Math.min(
      effectiveDay * days,
      effectiveWeek * Math.ceil(days / 7),
      effectiveMonth
    );
  } else {
    return Math.min(
      effectiveMonth * Math.ceil(days / 28),
      effectiveWeek * Math.ceil(days / 7)
    );
  }
}

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

// ==========================================
// CHAT ENDPOINT - Rate Daddy AI Assistant
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

    // Create or use existing thread
    let thread;
    if (threadId) {
      thread = { id: threadId };
    } else {
      thread = await openai.beta.threads.create();
      console.log('[/chat] Created new thread:', thread.id);
    }

    // Build context message for the assistant
    const contextPrefix = isLoggedIn 
      ? `[SYSTEM CONTEXT: User is logged in. user_id: ${userId}. Dashboard mode - full access to their invoices.]\n\n`
      : `[SYSTEM CONTEXT: User is NOT logged in. Landing page mode - general questions only, no invoice history access.]\n\n`;

    // Add user message to thread
    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: contextPrefix + message
    });

    // Run the assistant
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: RATE_DADDY_ASSISTANT_ID
    });

    // Poll for completion
    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    let attempts = 0;
    const maxAttempts = 60; // 60 seconds max

    while (runStatus.status !== 'completed' && attempts < maxAttempts) {
      if (runStatus.status === 'failed' || runStatus.status === 'cancelled') {
        console.log('[/chat] Run failed:', runStatus);
        return res.status(500).json({ error: 'Assistant run failed', status: runStatus.status });
      }

      // Handle function calls if the assistant needs to search invoices
      if (runStatus.status === 'requires_action') {
        const toolCalls = runStatus.required_action?.submit_tool_outputs?.tool_calls;
        
        if (toolCalls) {
          const toolOutputs = [];

          for (const toolCall of toolCalls) {
            console.log('[/chat] Tool call:', toolCall.function.name);
            const args = JSON.parse(toolCall.function.arguments);

            if (toolCall.function.name === 'search_invoices') {
              const searchResult = await searchInvoices(args.user_id || userId, args.query, args.filters);
              toolOutputs.push({
                tool_call_id: toolCall.id,
                output: JSON.stringify(searchResult)
              });
            } else if (toolCall.function.name === 'get_invoice_details') {
              const invoiceResult = await getInvoiceDetails(args.user_id || userId, args.invoice_id);
              toolOutputs.push({
                tool_call_id: toolCall.id,
                output: JSON.stringify(invoiceResult)
              });
            } else if (toolCall.function.name === 'get_savings_summary') {
              const savingsResult = await getSavingsSummary(args.user_id || userId, args.date_range);
              toolOutputs.push({
                tool_call_id: toolCall.id,
                output: JSON.stringify(savingsResult)
              });
            }
          }

          // Submit tool outputs
          await openai.beta.threads.runs.submitToolOutputs(thread.id, run.id, {
            tool_outputs: toolOutputs
          });
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      attempts++;
    }

    if (attempts >= maxAttempts) {
      return res.status(500).json({ error: 'Assistant timed out' });
    }

    // Get the assistant's response
    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantMessage = messages.data.find(m => m.role === 'assistant');

    if (!assistantMessage) {
      return res.status(500).json({ error: 'No response from assistant' });
    }

    const responseText = assistantMessage.content[0]?.text?.value || '';

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
// HELPER FUNCTIONS FOR ASSISTANT TOOLS
// ==========================================

async function searchInvoices(userId, query, filters = {}) {
  try {
    console.log('[searchInvoices] userId:', userId, 'query:', query, 'filters:', filters);

    if (!userId) {
      return { error: 'User not logged in', invoices: [] };
    }

    let dbQuery = supabase
      .from('parsed_invoices')
      .select('id, vendor_name, invoice_number, invoice_date, po_number, job_site, customer_name, rental_subtotal, freight, fees_total, tax, total, fee_percentage, equipment')
      .eq('user_id', userId)
      .order('invoice_date', { ascending: false });

    // Apply filters
    if (filters.vendor) {
      dbQuery = dbQuery.ilike('vendor_name', `%${filters.vendor}%`);
    }
    if (filters.date_from) {
      dbQuery = dbQuery.gte('invoice_date', filters.date_from);
    }
    if (filters.date_to) {
      dbQuery = dbQuery.lte('invoice_date', filters.date_to);
    }

    // Text search across multiple fields
    if (query) {
      dbQuery = dbQuery.or(`invoice_number.ilike.%${query}%,po_number.ilike.%${query}%,job_site.ilike.%${query}%,vendor_name.ilike.%${query}%,customer_name.ilike.%${query}%`);
    }

    const { data, error } = await dbQuery.limit(10);

    if (error) {
      console.log('[searchInvoices] Error:', error);
      return { error: error.message, invoices: [] };
    }

    console.log('[searchInvoices] Found:', data?.length || 0, 'invoices');
    return { invoices: data || [] };

  } catch (err) {
    console.error('[searchInvoices] Exception:', err);
    return { error: err.message, invoices: [] };
  }
}

async function getInvoiceDetails(userId, invoiceId) {
  try {
    console.log('[getInvoiceDetails] userId:', userId, 'invoiceId:', invoiceId);

    if (!userId) {
      return { error: 'User not logged in' };
    }

    const { data, error } = await supabase
      .from('parsed_invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('user_id', userId)
      .single();

    if (error) {
      console.log('[getInvoiceDetails] Error:', error);
      return { error: error.message };
    }

    return { invoice: data };

  } catch (err) {
    console.error('[getInvoiceDetails] Exception:', err);
    return { error: err.message };
  }
}

async function getSavingsSummary(userId, dateRange = {}) {
  try {
    console.log('[getSavingsSummary] userId:', userId, 'dateRange:', dateRange);

    if (!userId) {
      return { error: 'User not logged in' };
    }

    let query = supabase
      .from('parsed_invoices')
      .select('id, invoice_date, vendor_name, market_savings, fee_percentage, fees_total, rental_subtotal')
      .eq('user_id', userId);

    if (dateRange.from) {
      query = query.gte('invoice_date', dateRange.from);
    }
    if (dateRange.to) {
      query = query.lte('invoice_date', dateRange.to);
    }

    const { data, error } = await query;

    if (error) {
      console.log('[getSavingsSummary] Error:', error);
      return { error: error.message };
    }

    // Calculate summary
    const totalInvoices = data?.length || 0;
    const totalMarketSavings = data?.reduce((sum, inv) => sum + (parseFloat(inv.market_savings) || 0), 0) || 0;
    const totalFees = data?.reduce((sum, inv) => sum + (parseFloat(inv.fees_total) || 0), 0) || 0;
    const totalRental = data?.reduce((sum, inv) => sum + (parseFloat(inv.rental_subtotal) || 0), 0) || 0;
    const avgFeePercentage = totalRental > 0 ? (totalFees / totalRental) * 100 : 0;

    // Top savings opportunities
    const topSavings = data
      ?.filter(inv => inv.market_savings > 0)
      ?.sort((a, b) => b.market_savings - a.market_savings)
      ?.slice(0, 5) || [];

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
    console.error('[getSavingsSummary] Exception:', err);
    return { error: err.message };
  }
}

// ==========================================
// SEARCH INVOICES ENDPOINT (direct access)
// ==========================================

app.post('/search-invoices', async (req, res) => {
  try {
    const { userId, query, filters } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    const result = await searchInvoices(userId, query, filters);
    res.json(result);

  } catch (error) {
    console.error('[/search-invoices] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// INVOICE PARSING ENDPOINTS (existing)
// ==========================================

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

IMPORTANT - FREIGHT EXTRACTION:
Look for these line items in the SALES ITEMS section or anywhere on the invoice. These are FREIGHT charges - ADD THEM UP and put the total in the "freight" field:
- DELIVERY/PICK UP
- DELIVERY/PICKUP  
- OUTSIDE FREIGHT DELIVERY
- OUTSIDE FREIGHT PICKUP
- DELIVERY (by itself)
- PICKUP or PICK UP (by itself)
- HAULING
- MOBILIZATION
- DEMOBILIZATION

FEES (put in "fees" object - these are surcharges, NOT freight):
- TRANS SRVC SURCHARGE → fees.transport_surcharge
- ENVIRONMENTAL or ENV SURCHARGE → fees.environmental  
- DAMAGE WAIVER or LDW or RENTAL PROTECTION → fees.rental_protection
- FUEL SURCHARGE → fees.fuel_surcharge
- ADMIN FEE → fees.admin_fee
- Any other surcharge → fees.other

RENTAL_SUBTOTAL:
- Sum ONLY the equipment rental line items
- DO NOT include fees, freight, or tax

{
  "vendor": "Company name",
  "invoice_number": "Invoice number",
  "invoice_date": "YYYY-MM-DD",
  "po_number": "PO number or null",
  "customer_name": "Bill to name",
  "job_site": "Job site address or null",
  "equipment": [
    {
      "description": "Equipment name",
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
  "fees": {
    "transport_surcharge": 0.00,
    "environmental": 0.00,
    "fuel_surcharge": 0.00,
    "rental_protection": 0.00,
    "admin_fee": 0.00,
    "other": 0.00
  },
  "tax": 0.00,
  "total": 0.00,
  "confidence": "high"
}

Return ONLY the JSON, no markdown.`
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
    console.log("=== RAW OPENAI RESPONSE ===");
    console.log(content);
    console.log("=== END RAW RESPONSE ===");
    
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
    
    // Extract freight from fees if OpenAI missed it
    const freightKeywords = ['delivery', 'pickup', 'pick up', 'freight', 'hauling', 'mobilization', 'demobilization'];
    let extractedFreight = parseFloat(parsed.freight) || 0;
    let remainingFees = {};
    
    if (parsed.fees && typeof parsed.fees === 'object') {
      for (const [feeName, feeAmount] of Object.entries(parsed.fees)) {
        const lowerName = feeName.toLowerCase();
        const amount = parseFloat(feeAmount) || 0;
        const isFreight = freightKeywords.some(kw => lowerName.includes(kw));
        
        if (isFreight && amount > 0) {
          extractedFreight += amount;
          console.log("FOUND FREIGHT IN FEES:", feeName, amount);
        } else {
          remainingFees[feeName] = feeAmount;
        }
      }
    }
    
    const freight = extractedFreight;
    const feesTotal = Object.values(remainingFees).reduce((sum, f) => sum + (parseFloat(f) || 0), 0);
    const feePercentage = rentalSubtotal > 0 ? (feesTotal / rentalSubtotal) * 100 : 0;
    
    console.log("=== PARSED VALUES ===");
    console.log("freight:", freight);
    console.log("feesTotal:", feesTotal);
    console.log("rentalSubtotal:", rentalSubtotal);
    
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
      fees_total: feesTotal || null,
      tax: parseFloat(parsed.tax) || null,
      total: parseFloat(parsed.total) || null,
      fees: parsed.fees || {},
      equipment: parsed.equipment || [],
      fee_percentage: feePercentage || null,
      confidence: parsed.confidence || null,
      raw_response: parsed || {}
    }).select().single();
    
    console.log("=== INSERT RESULT ===");
    console.log("INSERT DATA:", JSON.stringify(insertData, null, 2));
    console.log("INSERT ERROR:", insertError);
    console.log("INSERT ID:", insertData?.id);
    
    if (insertError || !insertData || !insertData.id) {
      console.log("!!! INSERT FAILED - cannot proceed with market rate processing !!!");
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to insert invoice', 
        details: insertError 
      });
    }
    
    const invoiceId = insertData.id;
    console.log("Invoice ID confirmed:", invoiceId);
    
    let totalMarketSavings = 0;
    const equipmentWithRates = [];
    
    console.log("=== MARKET RATE PROCESSING START ===");
    console.log("Equipment count:", parsed.equipment?.length || 0);
    
    if (parsed.equipment && parsed.equipment.length > 0) {
      for (const item of parsed.equipment) {
        const rentalDays = parseInt(item.rental_days) || 1;
        
        let actualAmount = parseFloat(item.amount) || 0;
        
        if (actualAmount === 0) {
          actualAmount = calculateExpectedAmount(
            item.day_rate,
            item.week_rate,
            item.four_week_rate,
            rentalDays
          );
          console.log("Calculated amount from rates:", actualAmount, "for", item.description);
        }
        
        console.log("Processing item:", item.description, "amount:", actualAmount, "rental_days:", rentalDays);
        
        if (!item.description) {
          console.log("SKIP: No description");
          continue;
        }
        
        if (actualAmount === 0) {
          console.log("SKIP: No amount and couldn't calculate from rates for", item.description);
          continue;
        }
        
        try {
          console.log("Calling classify_equipment for:", item.description);
          const { data: classifyData, error: classifyError } = await supabase.rpc('classify_equipment', {
            p_description: item.description
          });
          
          console.log("classify_equipment result:", JSON.stringify(classifyData));
          console.log("classify_equipment error:", classifyError);
          
          if (classifyData && classifyData.length > 0) {
            const classified = classifyData[0];
            
            console.log("Calling calculate_savings:", classified.equipment_class, classified.equipment_size, actualAmount, rentalDays);
            const { data: savingsData, error: savingsError } = await supabase.rpc('calculate_savings', {
              p_equipment_class: classified.equipment_class,
              p_equipment_size: classified.equipment_size,
              p_actual_amount: actualAmount,
              p_rental_days: rentalDays,
              p_region: 'Cleveland'
            });
            
            console.log("calculate_savings result:", JSON.stringify(savingsData));
            console.log("calculate_savings error:", savingsError);
            
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
              
              const { error: ratesError } = await supabase.from('equipment_rates').insert({
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
              console.log("equipment_rates insert error:", ratesError);
            }
          }
        } catch (err) {
          console.log('Error processing equipment item:', err.message);
        }
      }
    }
    
    console.log("=== MARKET RATE PROCESSING COMPLETE ===");
    console.log("totalMarketSavings:", totalMarketSavings);
    console.log("equipmentWithRates count:", equipmentWithRates.length);
    
    console.log("=== UPDATING MARKET_SAVINGS ===");
    console.log("Invoice ID for update:", invoiceId);
    console.log("market_savings value:", totalMarketSavings);
    console.log("equipment_with_rates count:", equipmentWithRates.length);
    
    const { data: updateData, error: updateError } = await supabase
      .from('parsed_invoices')
      .update({
        market_savings: totalMarketSavings,
        equipment_with_rates: equipmentWithRates
      })
      .eq('id', invoiceId)
      .select();
    
    console.log("=== UPDATE RESULT ===");
    console.log("UPDATE DATA:", JSON.stringify(updateData, null, 2));
    console.log("UPDATE ERROR:", updateError);
    console.log("ROWS UPDATED:", updateData?.length || 0);
    
    if (updateError) {
      console.log("!!! UPDATE FAILED !!!");
    } else if (!updateData || updateData.length === 0) {
      console.log("!!! UPDATE RETURNED NO ROWS - something is wrong !!!");
    } else {
      console.log("SUCCESS: market_savings updated to", updateData[0].market_savings);
    }
    
    res.json({ 
      success: true, 
      data: {
        ...parsed,
        id: invoiceId,
        freight: freight,
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
  console.log(`ParseAPI running on port ${PORT}`);
});
module.exports = app;