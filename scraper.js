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

// --- PARSE COURSE_URLS ("Class Name|https://...", or plain URL) ---
function parseCourses(envStr) {
  return envStr.split(',').map(entry => {
    const trimmed = entry.trim();
    if (trimmed.includes('|')) {
      const [name, url] = trimmed.split('|');
      return { name: name.trim(), url: url.trim() };
    }
    return { name: '', url: trimmed };
  });
}

// --- PUSHOVER NOTIFICATION ---
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

// --- DATE PARSER FOR COURSEPOINT FORMAT ("Oct 26", "09:00 AM") ---
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

    const courses = parseCourses(process.env.COURSE_URLS);
    const firstCourseUrl = courses[0].url;

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

    const state = loadState();
    const now = new Date();
    let sentCount = 0;

    for (const course of courses) {
      const { url } = course;
      console.log(`Checking course: ${course.name || url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

      try {
        await page.waitForSelector('section.list-item', { timeout: 25000 });
      } catch {
        console.log(`No assignments found at ${page.url()}`);
        continue;
      }

      // 1. Expand all "Show Assignments" batch toggle buttons
      const expandedCount = await page.evaluate(() => {
        const toggleButtons = document.querySelectorAll('button.batch-assignment-toggle[aria-expanded="false"]');
        toggleButtons.forEach(btn => btn.click());
        return toggleButtons.length;
      });

      if (expandedCount > 0) {
        console.log(`Expanded ${expandedCount} batch assignment group(s). Waiting for sub-items to load...`);
        await new Promise(r => setTimeout(r, 2500));
      }

      // 2. Scrape page course header (as fallback if no custom name in .env) and assignments
      const pageData = await page.evaluate(() => {
        // Fallback: Try to grab course title from page header/breadcrumb if not defined in .env
        const headerEl = document.querySelector('h1, .course-title, .course-name, [class*="courseTitle"], [class*="header-title"]');
        const detectedCourseName = headerEl?.innerText.replace(/\s+/g, ' ').trim() || '';

        const allSections = Array.from(document.querySelectorAll('section.list-item'));
        const topLevelSections = allSections.filter(sec => !sec.closest('section.assignment-activity'));

        const items = topLevelSections.map(section => {
          const titleBtn = section.querySelector('button.assignment-title');
          const title = titleBtn?.getAttribute('title') || titleBtn?.innerText.trim();
          const eventId = titleBtn?.getAttribute('data-eventid');

          const dateText = section.querySelector('.dueDate p')?.innerText.replace(/\s+/g, ' ').trim() || '';
          const timeText = section.querySelector('.dueTime .due-time')?.innerText.replace(/\s+/g, ' ').trim() || '11:59 PM';

          const statusText = section.querySelector('.assignment-status-container')?.innerText.replace(/\s+/g, ' ').trim() || '';
          let isSubmitted = statusText.toLowerCase().includes('submitted') || statusText.toLowerCase().includes('completed');

          const parentLi = section.closest('li[role="listitem"]');
          if (!isSubmitted && parentLi) {
            const subSections = Array.from(parentLi.querySelectorAll('section.assignment-activity section.list-item'));
            if (subSections.length > 0) {
              const allSubsSubmitted = subSections.every(sub => {
                const subStatus = sub.querySelector('.assignment-status-container')?.innerText.replace(/\s+/g, ' ').trim().toLowerCase() || '';
                return subStatus.includes('submitted') || subStatus.includes('completed');
              });
              if (allSubsSubmitted) {
                isSubmitted = true;
              }
            }
          }

          return {
            id: eventId || `${title}-${dateText}`,
            title,
            dateText,
            timeText,
            statusText,
            isSubmitted
          };
        });

        return { detectedCourseName, items };
      });

      const className = course.name || pageData.detectedCourseName || 'CoursePoint';
      const assignments = pageData.items;

      console.log(`Found ${assignments.length} top-level assignments for [${className}]. Checking notification rules...`);

      for (const item of assignments) {
        if (!item.title || !item.dateText) continue;

        const dueDate = parseDueDate(item.dateText, item.timeText);
        const hoursUntilDue = (dueDate - now) / (1000 * 60 * 60);

        if (hoursUntilDue < 0) continue;

        if (!state[item.id]) {
          state[item.id] = {
            course: className,
            title: item.title,
            dueString: `${item.dateText} at ${item.timeText}`,
            completed: false,
            notifiedNew: false,
            notified7Days: false,
            notified1Day: false
          };
        }

        const record = state[item.id];
        record.course = className;

        // Skip completed assignments (single or batch)
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
            `New Assignment: ${className}`,
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
            `Due in 1 Week: ${className}`,
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
            `Due Tomorrow: ${className}`,
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