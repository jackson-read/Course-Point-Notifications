import puppeteer from 'puppeteer-core';
import cron from 'node-cron';
import fs from 'fs';
import 'dotenv/config';

const CACHE_FILE = './assignments_state.json';

// --- STATE MANAGEMENT ---
function loadState() {
  if (!fs.existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(state, null, 2));
}

// --- PUSHOVER NOTIFICATION ---
async function sendPushover(title, message, url, priority = '0') {
  const payload = new URLSearchParams({
    token: process.env.PUSHOVER_TOKEN,
    user: process.env.PUSHOVER_USER,
    title,
    message,
    url,
    url_title: 'View Assignments',
    priority,
    sound: 'pushover'
  });

  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      body: payload
    });
    if (!res.ok) console.error('Pushover API Error:', await res.text());
  } catch (err) {
    console.error('Failed to reach Pushover:', err);
  }
}

// --- DATE PARSER FOR COURSEPOINT FORMAT ("Oct 18", "11:59 PM") ---
function parseDueDate(dateStr, timeStr) {
  const now = new Date();
  let year = now.getFullYear();

  // Combine into standard parseable string: "Oct 18, 2026 11:59 PM"
  const cleanDate = dateStr.replace(/\s+/g, ' ').trim();
  const cleanTime = timeStr.replace(/\s+/g, ' ').trim();
  let parsed = new Date(`${cleanDate}, ${year} ${cleanTime}`);

  // Handle New Year rollover (e.g. checking in Dec for a Jan assignment)
  if (parsed - now < -1000 * 60 * 60 * 24 * 60) {
    parsed = new Date(`${cleanDate}, ${year + 1} ${cleanTime}`);
  }
  return parsed;
}

// --- MAIN SCRAPER ENGINE ---
async function runCheck() {
  console.log(`[${new Date().toLocaleTimeString()}] Starting CoursePoint check...`);

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH || '/data/data/com.termux/files/usr/bin/chromium-browser',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // 1. Trigger fresh SSO redirect & Log In
    console.log('Navigating to login portal...');
    await page.goto('https://medicine.lww.com/MyContent', { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for the SSO Email input
    await page.waitForSelector('#Email', { timeout: 30000 });
    await page.type('#Email', process.env.CP_EMAIL, { delay: 40 });
    await page.type('#Password', process.env.CP_PASS, { delay: 40 });

    console.log('Submitting credentials...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
      page.click('#primaryLoginButton')
    ]);

    // Optional: Click "Launch to courses" if needed to establish session cookies for phoenix-ccm
    try {
      const launchBtn = await page.waitForSelector('::-p-text(Launch to courses)', { timeout: 8000 });
      if (launchBtn) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }),
          launchBtn.click()
        ]);
      }
    } catch {
      console.log('Skipping Launch button or already authenticated.');
    }

    // 2. Loop through each Course Assignment URL
    const courseUrls = process.env.COURSE_URLS.split(',').map(u => u.trim());
    const state = loadState();
    const now = new Date();

    for (const url of courseUrls) {
      console.log(`Checking course URL: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      // Wait for Angular to render the assignment cards
      try {
        await page.waitForSelector('section.list-item', { timeout: 25000 });
      } catch {
        console.log('No assignments currently listed on this page.');
        continue;
      }

      // Extract details directly from the Angular DOM
      const assignments = await page.evaluate(() => {
        const items = document.querySelectorAll('section.list-item');
        return Array.from(items).map(section => {
          const titleBtn = section.querySelector('button.assignment-title');
          const title = titleBtn?.getAttribute('title') || titleBtn?.innerText.trim();
          const eventId = titleBtn?.getAttribute('data-eventid');

          const dateText = section.querySelector('.dueDate p')?.innerText.replace(/\s+/g, ' ').trim() || '';
          const timeText = section.querySelector('.dueTime .due-time')?.innerText.replace(/\s+/g, ' ').trim() || '11:59 PM';

          return {
            id: eventId || `${title}-${dateText}`,
            title,
            dateText,
            timeText
          };
        });
      });

      console.log(`Found ${assignments.length} assignments. Checking notification rules...`);

      // 3. Evaluate Notification Rules (New, 7-Day, 1-Day)
      for (const item of assignments) {
        if (!item.title || !item.dateText) continue;

        const dueDate = parseDueDate(item.dateText, item.timeText);
        const hoursUntilDue = (dueDate - now) / (1000 * 60 * 60);

        // Skip past-due assignments
        if (hoursUntilDue < 0) continue;

        // Initialize tracking record if brand new
        if (!state[item.id]) {
          state[item.id] = {
            title: item.title,
            dueString: `${item.dateText} at ${item.timeText}`,
            notifiedNew: false,
            notified7Days: false,
            notified1Day: false
          };
        }

        const record = state[item.id];

        // Rule A: Brand New Assignment Posted
        if (!record.notifiedNew) {
          await sendPushover(
            'New CoursePoint Assignment',
            `${item.title}\nDue: ${item.dateText} at ${item.timeText}`,
            url,
            '0'
          );
          record.notifiedNew = true;
          // If a new assignment is posted already inside the 7-day or 1-day window,
          // mark those flags appropriately so you don't get double-pinged right away.
          if (hoursUntilDue <= 168 && hoursUntilDue > 24) record.notified7Days = true;
          if (hoursUntilDue <= 24) {
            record.notified7Days = true;
            record.notified1Day = true;
          }
          continue;
        }

        // Rule B: 1 Week (7 Days / <= 168 hours) Warning
        if (!record.notified7Days && hoursUntilDue <= 168 && hoursUntilDue > 24) {
          const daysLeft = Math.ceil(hoursUntilDue / 24);
          await sendPushover(
            'Upcoming Due Date (1 Week)',
            `${item.title}\nDue in ~${daysLeft} days (${item.dateText} at ${item.timeText})`,
            url,
            '0'
          );
          record.notified7Days = true;
        }

        // Rule C: 1 Day (<= 24 hours) Urgent Warning
        if (!record.notified1Day && hoursUntilDue <= 24 && hoursUntilDue > 0) {
          const hrsLeft = Math.round(hoursUntilDue);
          await sendPushover(
            'Due Tomorrow: CoursePoint',
            `${item.title}\nDue in ${hrsLeft} hours (${item.dateText} at ${item.timeText})`,
            url,
            '1' // Priority 1 = High priority alert
          );
          record.notified1Day = true;
        }
      }
    }

    saveState(state);
    console.log('Check finished successfully.');

  } catch (error) {
    console.error('Scraper encountered an error:', error);
  } finally {
    await browser.close();
  }
}

// Run immediately on boot, then every 2 hours on the hour
runCheck();
cron.schedule('0 */2 * * *', () => {
  runCheck();
});