exports.handler = async function () {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.REMINDER_FROM_EMAIL;

  if (!supabaseUrl || !serviceRoleKey || !resendKey || !fromAddress) {
    return { statusCode: 500, body: "Missing reminder job configuration" };
  }

  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  const today = new Date().toISOString().slice(0, 10);
  const recurringResponse = await fetch(`${supabaseUrl}/rest/v1/recurring_templates?select=id,user_id,type,category,amount,description,next_date,pending_date,reminder_days&type=eq.expense&reminder_days=gt.0`, { headers });
  if (!recurringResponse.ok) throw new Error(await recurringResponse.text());
  const templates = await recurringResponse.json();

  const due = templates.filter(template => {
    const dueDate = template.pending_date || template.next_date;
    const days = Math.ceil((Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
    return days >= 0 && days <= template.reminder_days;
  });

  let sent = 0;
  for (const template of due) {
    const usersResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users/${template.user_id}`, { headers });
    if (!usersResponse.ok) continue;
    const user = await usersResponse.json();
    const email = user.email;
    if (!email) continue;

    const deliveryDate = template.pending_date || template.next_date;
    const deliveryResponse = await fetch(`${supabaseUrl}/rest/v1/reminder_deliveries?user_id=eq.${template.user_id}&recurring_template_id=eq.${template.id}&delivery_date=eq.${deliveryDate}&channel=eq.email`, { headers });
    if (deliveryResponse.ok && (await deliveryResponse.json()).length) continue;

    const sendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromAddress,
        to: [email],
        subject: `Bill reminder: ${template.description === "-" ? template.category : template.description}`,
        text: `${template.description === "-" ? template.category : template.description} is due on ${deliveryDate}. Amount: ${template.amount}.`
      })
    });
    if (!sendResponse.ok) continue;

    await fetch(`${supabaseUrl}/rest/v1/reminder_deliveries`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ user_id: template.user_id, recurring_template_id: template.id, delivery_date: deliveryDate, channel: "email" })
    });
    sent++;
  }
  return { statusCode: 200, body: JSON.stringify({ sent }) };
};
