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

// --- PUSHOVER NOTIFICATION (Returns true if delivered, false if failed) ---
async function sendPushover(title, message, url, priority = '0') {
  const payload = new URLSearchParams({
    token: process.env.PUSHOVER_TOKEN?.trim(),
    user: process.env.PUSHOVER_USER?.trim(),
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
    if (!res.ok) {
      console.error('Pushover API Error:', await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('Failed to reach Pushover:', err);
    return false;
  }
}

// --- DATE PARSER FOR COURSEPOINT FORMAT ("Oct 18", "11:59 PM") ---
function parseDueDate(dateStr, timeStr) {
  const now = new Date();
  let year = now.getFullYear();

  const cleanDate = dateStr.replace(/\s+/g, ' ').trim();
  const cleanTime = timeStr.replace(/\s+/g, ' ').trim();
  let parsed = new Date(`${cleanDate}, ${year} ${cleanTime}`);

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
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--ignore-certificate-errors'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
    );

    const courseUrls = process.env.COURSE_URLS.split(',').map(u => u.trim());
    const firstCourseUrl = courseUrls[0];

    console.log('Navigating to login portal...');
    await page.goto('https://medicine.lww.com/MyContent', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    }).catch(e => console.log('Redirect note:', e.message));

    if (!page.url().includes('sso.wkhpe.com')) {
      const loginLink = await page.$('a[href*="Login"], a[href*="sso"], button[id*="login"], .login-btn');
      if (loginLink) {
        await loginLink.click();
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
    }

    try {
      await page.waitForSelector('#Email', { timeout: 15000 });
    } catch {
      console.log('Trying direct course URL to force SSO...');
      await page.goto(firstCourseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }).catch(e => console.log('Course redirect note:', e.message));
      await page.waitForSelector('#Email', { timeout: 30000 });
    }

    console.log('Entering credentials...');
    await page.type('#Email', process.env.CP_EMAIL, { delay: 40 });
    await page.type('#Password', process.env.CP_PASS, { delay: 40 });

    console.log('Submitting credentials...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
      page.click('#primaryLoginButton')
    ]);

    await new Promise(r => setTimeout(r, 6000));

    // Optional: Click "Launch to courses" if present
    try {
      const launchBtn = await page.waitForSelector('::-p-text(Launch to courses)', { timeout: 8000 });
      if (launchBtn) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
          launchBtn.click()
        ]);
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch {
      console.log('Skipping Launch button or already authenticated.');
    }

    // Loop through each Course Assignment URL
    const state = loadState();
    const now = new Date();
    let sentCount = 0;

    for (const url of courseUrls) {
      console.log(`Checking course URL: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

      try {
        await page.waitForSelector('section.list-item', { timeout: 25000 });
      } catch {
        console.log(`No assignments found at ${page.url()}`);
        continue;
      }

      const assignments = await page.evaluate(() => {
        const items = document.querySelectorAll('section.list-item');
        return Array.from(items).map(section => {
          const titleBtn = section.querySelector('button.assignment-title');
          const title = titleBtn?.getAttribute('title') || titleBtn?.innerText.trim();
          const eventId = titleBtn?.getAttribute('data-eventid');

          const dateText = section.querySelector('.dueDate p')?.innerText.replace(/\s+/g, ' ').trim() || '';
          const timeText = section.querySelector('.dueTime .due-time')?.innerText.replace(/\s+/g, ' ').trim() || '11:59 PM';

          // Grab the submission status ("Submitted", "-", or empty)
          const statusText = section.querySelector('.assignment-status-container')?.innerText.replace(/\s+/g, ' ').trim() || '';
          const isSubmitted = statusText.toLowerCase().includes('submitted') || statusText.toLowerCase().includes('completed');

          return {
            id: eventId || `${title}-${dateText}`,
            title,
            dateText,
            timeText,
            statusText,
            isSubmitted
          };
        });
      });

      console.log(`Found ${assignments.length} assignments. Checking notification rules...`);

      for (const item of assignments) {
        if (!item.title || !item.dateText) continue;

        const dueDate = parseDueDate(item.dateText, item.timeText);
        const hoursUntilDue = (dueDate - now) / (1000 * 60 * 60);

        if (hoursUntilDue < 0) continue;

        if (!state[item.id]) {
          state[item.id] = {
            title: item.title,
            dueString: `${item.dateText} at ${item.timeText}`,
            completed: false,
            notifiedNew: false,
            notified7Days: false,
            notified1Day: false
          };
        }

        const record = state[item.id];

        // --- NEW COMPLETION CHECK ---
        // If CoursePoint shows "Submitted", mark it completed and skip all alerts!
        if (item.isSubmitted) {
          record.completed = true;
          record.notifiedNew = true;
          record.notified7Days = true;
          record.notified1Day = true;
          continue;
        }

        // Rule A: Brand New Assignment Posted
        if (!record.notifiedNew) {
          const ok = await sendPushover(
            'New CoursePoint Assignment',
            `${item.title}\nDue: ${item.dateText} at ${item.timeText}`,
            url,
            '0'
          );
          if (ok) {
            record.notifiedNew = true;
            sentCount++;
            if (hoursUntilDue <= 168 && hoursUntilDue > 24) record.notified7Days = true;
            if (hoursUntilDue <= 24) {
              record.notified7Days = true;
              record.notified1Day = true;
            }
          }
          continue;
        }

        // Rule B: 1 Week (7 Days / <= 168 hours) Warning
        if (!record.notified7Days && hoursUntilDue <= 168 && hoursUntilDue > 24) {
          const daysLeft = Math.ceil(hoursUntilDue / 24);
          const ok = await sendPushover(
            'Upcoming Due Date (1 Week)',
            `${item.title}\nDue in ~${daysLeft} days (${item.dateText} at ${item.timeText})`,
            url,
            '0'
          );
          if (ok) {
            record.notified7Days = true;
            sentCount++;
          }
        }

        // Rule C: 1 Day (<= 24 hours) Urgent Warning
        if (!record.notified1Day && hoursUntilDue <= 24 && hoursUntilDue > 0) {
          const hrsLeft = Math.round(hoursUntilDue);
          const ok = await sendPushover(
            'Due Tomorrow: CoursePoint',
            `${item.title}\nDue in ${hrsLeft} hours (${item.dateText} at ${item.timeText})`,
            url,
            '1'
          );
          if (ok) {
            record.notified1Day = true;
            sentCount++;
          }
        }
      }
    }

    saveState(state);
    console.log(`Check finished successfully. Sent ${sentCount} notifications.`);

  } catch (error) {
    console.error('Scraper encountered an error:', error);
  } finally {
    await browser.close();
  }
}

runCheck();
cron.schedule('0 */2 * * *', () => {
  runCheck();
});