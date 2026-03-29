CREATE TABLE IF NOT EXISTS universities (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  email_domain TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS communities (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  region     TEXT NOT NULL,
  flag_emoji TEXT NOT NULL,
  color_hex  TEXT NOT NULL DEFAULT '#c8f04e'
);

CREATE TABLE IF NOT EXISTS users (
  id               SERIAL PRIMARY KEY,
  email            TEXT UNIQUE NOT NULL,
  name             TEXT,
  major            TEXT,
  year             TEXT,
  bio              TEXT,
  instagram        TEXT,
  linkedin         TEXT,
  photo_url        TEXT,
  university_id    INTEGER REFERENCES universities(id),
  gender           TEXT,
  hide_community   BOOLEAN DEFAULT FALSE,
  profile_complete BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_communities (
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, community_id)
);

CREATE TABLE IF NOT EXISTS courses (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  schedule      TEXT,
  room          TEXT,
  term          TEXT NOT NULL,
  university_id INTEGER REFERENCES universities(id)
);

CREATE TABLE IF NOT EXISTS enrollments (
  user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, course_id)
);

CREATE TABLE IF NOT EXISTS otp_tokens (
  id         SERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  code       TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Column migrations (safe to run on existing tables) ───────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS gender                  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan                    TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_online               BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active               BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen               TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS browse_privately        BOOLEAN DEFAULT FALSE;
-- Auth & security columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at       TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at           TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until            TIMESTAMPTZ;
-- Billing columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status     TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS revenuecat_customer_id  TEXT;
-- Soft delete
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at              TIMESTAMPTZ;
-- Push notifications (Expo push token — null until device registers)
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token              TEXT;
-- OTP purpose column (signup | login | reset)
ALTER TABLE otp_tokens ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'signup';
-- ─── Production indexes ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_university_major_year ON users(university_id, major, year);
CREATE INDEX IF NOT EXISTS idx_users_plan                  ON users(plan);
CREATE INDEX IF NOT EXISTS idx_users_deleted               ON users(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_friendships_user1           ON friendships(user1_id);
CREATE INDEX IF NOT EXISTS idx_friendships_user2           ON friendships(user2_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv_created       ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_professor_reviews_created   ON professor_reviews(professor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_tokens_lookup           ON otp_tokens(email, purpose, used, expires_at);

CREATE TABLE IF NOT EXISTS profile_visits (
  id              SERIAL PRIMARY KEY,
  visitor_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  visited_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  visited_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_profile_visits_visited ON profile_visits (visited_user_id, visited_at DESC);

CREATE TABLE IF NOT EXISTS departments (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  university_id INTEGER REFERENCES universities(id) ON DELETE CASCADE,
  UNIQUE (name, university_id)
);
CREATE INDEX IF NOT EXISTS idx_departments_university ON departments(university_id);

CREATE TABLE IF NOT EXISTS professors (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  department    TEXT,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  university_id INTEGER REFERENCES universities(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_professors_university ON professors(university_id, name);
-- Migrations: add columns to existing professors table if not present
ALTER TABLE professors ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_professors_department ON professors(department_id);

CREATE TABLE IF NOT EXISTS professor_reviews (
  id             SERIAL PRIMARY KEY,
  professor_id   INTEGER REFERENCES professors(id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
  course_code    TEXT NOT NULL,
  rating         INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment        TEXT,
  grade_received TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, professor_id, course_code)
);
CREATE INDEX IF NOT EXISTS idx_professor_reviews_prof ON professor_reviews(professor_id, course_code);

-- ─── Unique constraints (safe to run on existing data) ─────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'communities_name_unique'
  ) THEN
    DELETE FROM communities WHERE id NOT IN (
      SELECT MIN(id) FROM communities GROUP BY name
    );
    ALTER TABLE communities ADD CONSTRAINT communities_name_unique UNIQUE (name);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'courses_code_term_uni_unique'
  ) THEN
    DELETE FROM courses WHERE id NOT IN (
      SELECT MIN(id) FROM courses GROUP BY code, term, university_id
    );
    ALTER TABLE courses ADD CONSTRAINT courses_code_term_uni_unique UNIQUE (code, term, university_id);
  END IF;
END $$;

-- ─── Social tables ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS friend_requests (
  id          SERIAL PRIMARY KEY,
  sender_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (sender_id, receiver_id)
);

CREATE TABLE IF NOT EXISTS friendships (
  user1_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  user2_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user1_id, user2_id),
  CHECK (user1_id < user2_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id         SERIAL PRIMARY KEY,
  user1_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  user2_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user1_id, user2_id),
  CHECK (user1_id < user2_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  read            BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Universities ──────────────────────────────────────────────────────────

-- Add display columns to universities
ALTER TABLE universities ADD COLUMN IF NOT EXISTS slug       TEXT;
ALTER TABLE universities ADD COLUMN IF NOT EXISTS short_name TEXT;

INSERT INTO universities (name, slug, short_name, email_domain) VALUES
  ('Simon Fraser University',         'sfu',    'SFU',     'sfu.ca'),
  ('University of British Columbia',  'ubc',    'UBC',     'ubc.ca'),
  ('McGill University',               'mcgill', 'McGill',  'mcgill.ca'),
  ('Queen''s University',             'queens', 'Queen''s','queensu.ca')
ON CONFLICT (email_domain) DO UPDATE SET
  slug       = EXCLUDED.slug,
  short_name = EXCLUDED.short_name,
  name       = EXCLUDED.name;

-- Remove University of Toronto if it was inserted previously
DELETE FROM universities WHERE email_domain = 'utoronto.ca';

-- ─── Communities ──────────────────────────────────────────────────────────

INSERT INTO communities (name, region, flag_emoji, color_hex) VALUES
  ('Arab Community',                       'Middle East', '🌙', '#c8a84b'),
  ('Iranian/Persian Community',            'Middle East', '🇮🇷', '#c41e3a'),
  ('Turkish Community',                    'Middle East', '🇹🇷', '#e30a17'),
  ('Balkan Community',                     'Europe',      '⚓',  '#003087'),
  ('Polish Community',                     'Europe',      '🇵🇱', '#dc143c'),
  ('Ukrainian/Eastern European Community', 'Europe',      '🇺🇦', '#005bbb'),
  ('East Asian Community',                 'Asia',        '🏮', '#de2910'),
  ('South Asian Community',                'Asia',        '🌺', '#ff9933'),
  ('Southeast Asian Community',            'Asia',        '🌴', '#009b77'),
  ('Filipino Community',                   'Asia',        '🇵🇭', '#0038a8'),
  ('East African Community',               'Africa',      '🦁', '#078930'),
  ('North African Community',              'Africa',      '🌅', '#c09300'),
  ('Sub-Saharan African Community',        'Africa',      '🥁', '#cc0001'),
  ('West African Community',               'Africa',      '🌍', '#006b3f'),
  ('Latin American Community',             'Americas',    '🌶', '#cf142b'),
  ('Indigenous Community',                 'Americas',    '🪶', '#8b4513')
ON CONFLICT (name) DO NOTHING;

-- ─── Courses (SFU) ────────────────────────────────────────────────────────

INSERT INTO courses (code, name, schedule, room, term, university_id) VALUES
  -- Spring 2025
  ('CMPT 120',  'Introduction to Computing Science',        'Mon/Wed/Fri 9:30–10:20',   'AQ 3003',   'Spring 2025', 1),
  ('CMPT 225',  'Data Structures and Algorithms',           'Tue/Thu 10:30–11:20',      'AQ 5008',   'Spring 2025', 1),
  ('CMPT 276',  'Introduction to Software Engineering',     'Mon/Wed 13:30–14:20',      'AQ 5008',   'Spring 2025', 1),
  ('CMPT 310',  'Introduction to Artificial Intelligence',  'Mon/Wed 10:30–11:20',      'AQ 3003',   'Spring 2025', 1),
  ('CMPT 354',  'Database Systems I',                       'Tue/Thu 12:30–13:20',      'TASC 9204', 'Spring 2025', 1),
  ('CMPT 372',  'Web Development II',                       'Tue/Thu 14:30–15:20',      'TASC 9204', 'Spring 2025', 1),
  ('CMPT 376',  'Technical Writing and Group Dynamics',     'Mon/Wed/Fri 11:30–12:20',  'AQ 3005',   'Spring 2025', 1),
  ('CMPT 431',  'Distributed Systems',                      'Tue/Thu 8:30–9:20',        'TASC 9408', 'Spring 2025', 1),
  ('CMPT 474',  'Web API Design',                           'Mon/Wed 15:30–16:20',      'TASC 9204', 'Spring 2025', 1),
  ('BUS 207',   'Introduction to Finance',                  'Mon/Wed/Fri 8:30–9:20',    'WMC 3520',  'Spring 2025', 1),
  ('BUS 237',   'Introduction to Business Technology',      'Tue/Thu 11:30–12:20',      'WMC 2200',  'Spring 2025', 1),
  ('BUS 254',   'Introduction to Accounting',               'Mon/Wed/Fri 13:30–14:20',  'WMC 2200',  'Spring 2025', 1),
  ('BUS 360',   'Marketing Management',                     'Mon/Wed/Fri 9:30–10:20',   'WMC 2200',  'Spring 2025', 1),
  ('BUS 380',   'Business Statistics',                      'Tue/Thu 9:30–10:20',       'WMC 3250',  'Spring 2025', 1),
  ('BUS 478',   'Strategic Management',                     'Mon/Wed 16:30–17:50',      'WMC 3520',  'Spring 2025', 1),
  ('ENSC 215',  'Electric Circuits I',                      'Mon/Wed/Fri 10:30–11:20',  'SWH 10081', 'Spring 2025', 1),
  ('ENSC 320',  'Electric Circuits II',                     'Tue/Thu 14:30–15:20',      'SWH 10041', 'Spring 2025', 1),
  ('ENSC 380',  'Engineering Economics',                    'Mon/Wed/Fri 12:30–13:20',  'SWH 10041', 'Spring 2025', 1),
  ('ENSC 450',  'Wireless Communications',                  'Tue/Thu 16:30–17:20',      'SWH 10081', 'Spring 2025', 1),
  ('MATH 151',  'Calculus I',                               'Mon/Wed/Fri 8:30–9:20',    'C9001',     'Spring 2025', 1),
  ('MATH 152',  'Calculus II',                              'Mon/Wed/Fri 10:30–11:20',  'C9002',     'Spring 2025', 1),
  ('MATH 251',  'Calculus III',                             'Mon/Wed/Fri 11:30–12:20',  'C9001',     'Spring 2025', 1),
  ('PSYC 100',  'Introduction to Psychology',               'Mon/Wed 9:30–10:20',       'RCB 6125',  'Spring 2025', 1),
  ('PSYC 201',  'Research Methods in Psychology',           'Tue/Thu 10:30–11:20',      'RCB 8100',  'Spring 2025', 1),
  ('PSYC 362',  'Social Psychology',                        'Mon/Wed 11:30–12:20',      'RCB 6125',  'Spring 2025', 1),
  ('CMNS 110',  'Introduction to Communication',            'Tue/Thu 13:30–14:20',      'AQ 3149',   'Spring 2025', 1),
  ('CMNS 253',  'Communication and Technology',             'Mon/Wed 14:30–15:20',      'AQ 3149',   'Spring 2025', 1),
  ('IAT 339',   'Web Design and New Media',                 'Mon/Wed 13:30–14:50',      'SUR 3320',  'Spring 2025', 1),
  ('PHYS 120',  'Modern Physics and Mechanics',             'Mon/Wed/Fri 9:30–10:20',   'AQ 3182',   'Spring 2025', 1),
  -- Fall 2024
  ('CMPT 276',  'Introduction to Software Engineering',     'Mon/Wed 13:30–14:20',      'AQ 5008',   'Fall 2024',   1),
  ('BUS 272',   'Behaviour in Organizations',               'Tue/Thu 8:30–9:20',        'WMC 3250',  'Fall 2024',   1),
  ('CMPT 225',  'Data Structures and Algorithms',           'Mon/Wed/Fri 10:30–11:20',  'AQ 3003',   'Fall 2024',   1),
  ('PSYC 100',  'Introduction to Psychology',               'Mon/Wed 9:30–10:20',       'RCB 6125',  'Fall 2024',   1)
ON CONFLICT (code, term, university_id) DO NOTHING;

-- ─── Students (SFU) ───────────────────────────────────────────────────────

INSERT INTO users (email, name, major, year, bio, instagram, linkedin, university_id, profile_complete) VALUES
  -- Computer Science (10)
  ('aisha.khan@sfu.ca',       'Aisha Khan',         'Computer Science',      'Year 3', 'Passionate about AI and machine learning. Love hackathons and building things that matter.', '@aishakhan_codes', 'aisha-khan-sfu', 1, TRUE),
  ('marco.reyes@sfu.ca',      'Marco Reyes',        'Computer Science',      'Year 2', 'Web dev enthusiast. Coffee addict. Currently obsessed with React and TypeScript.', '@marco.codes', 'marco-reyes-dev', 1, TRUE),
  ('sara.tehrani@sfu.ca',     'Sara Tehrani',       'Computer Science',      'Year 4', 'Final year CS student. Love distributed systems and open-source projects.', '@sara.t', 'sara-tehrani', 1, TRUE),
  ('james.liu@sfu.ca',        'James Liu',          'Computer Science',      'Year 1', 'First year CS student. Super excited to dive into algorithms and data structures.', '@jamesliu_sfu', NULL, 1, TRUE),
  ('priya.sharma@sfu.ca',     'Priya Sharma',       'Computer Science',      'Year 3', 'Interested in cybersecurity and backend systems. TA for CMPT 225.', '@priyasharms', 'priya-sharma-sfu', 1, TRUE),
  ('daniel.osei@sfu.ca',      'Daniel Osei',        'Computer Science',      'Year 2', 'Building apps that solve real problems. Big fan of clean code and good design.', '@danosei', 'daniel-osei', 1, TRUE),
  ('fatima.al-sayed@sfu.ca',  'Fatima Al-Sayed',    'Computer Science',      'Year 4', 'Graduating this spring. Software engineer intern at a Vancouver startup. Love mentoring.', '@fatima.codes', 'fatima-alsayed', 1, TRUE),
  ('lucas.martin@sfu.ca',     'Lucas Martin',       'Computer Science',      'Year 2', 'Into game dev and graphics. Blender and Unity are my jam.', '@lucasmdev', NULL, 1, TRUE),
  ('mei.zhang@sfu.ca',        'Mei Zhang',          'Computer Science',      'Year 3', 'NLP researcher. Working on my undergrad thesis about sentiment analysis in social media.', '@meizhang_sfu', 'mei-zhang-nlp', 1, TRUE),
  ('omar.hassan@sfu.ca',      'Omar Hassan',        'Computer Science',      'Year 1', 'Aspiring software engineer. Spent the summer learning Python. Here to level up.', '@omar_h', NULL, 1, TRUE),

  -- Business (8)
  ('jessica.park@sfu.ca',     'Jessica Park',       'Business',              'Year 3', 'Marketing major. Case competition fanatic. Love brand strategy and consumer psychology.', '@jesspark_sfu', 'jessica-park-biz', 1, TRUE),
  ('alex.nguyen@sfu.ca',      'Alex Nguyen',        'Business',              'Year 2', 'Finance track. Stocks, startups, and spreadsheets. Treasurer of SFU Investment Club.', '@alexnguyen_inv', 'alex-nguyen-fin', 1, TRUE),
  ('sofia.rodriguez@sfu.ca',  'Sofia Rodriguez',    'Business',              'Year 4', 'Entrepreneurship and strategy. Just launched a small e-commerce side hustle.', '@sofiarodriguez', 'sofia-rodriguez-sfu', 1, TRUE),
  ('kevin.chen@sfu.ca',       'Kevin Chen',         'Business',              'Year 2', 'Accounting & Finance double concentration. Big 4 is the goal.', '@kevinchen_sfu', NULL, 1, TRUE),
  ('amara.diallo@sfu.ca',     'Amara Diallo',       'Business',              'Year 3', 'Supply chain and operations. Internship at a logistics firm last summer.', '@amaradiallo', 'amara-diallo-ops', 1, TRUE),
  ('ryan.kowalski@sfu.ca',    'Ryan Kowalski',      'Business',              'Year 1', 'Just declared business. Interested in real estate and investment.', '@ryankowalski', NULL, 1, TRUE),
  ('nina.patel@sfu.ca',       'Nina Patel',         'Business',              'Year 4', 'HR and organizational behavior. Thesis on remote work culture post-pandemic.', '@ninapatel_sfu', 'nina-patel-hr', 1, TRUE),
  ('carlos.mendez@sfu.ca',    'Carlos Mendez',      'Business',              'Year 3', 'International business and Spanish. Want to work in Latin America after graduation.', '@carlosmendez_sfu', NULL, 1, TRUE),

  -- Engineering (7)
  ('yuna.kim@sfu.ca',         'Yuna Kim',           'Engineering',           'Year 4', 'Mechatronics engineering. Senior design project: autonomous delivery robot.', '@yunakim_eng', 'yuna-kim-eng', 1, TRUE),
  ('ibrahim.ali@sfu.ca',      'Ibrahim Ali',        'Engineering',           'Year 2', 'Computer engineering. Obsessed with embedded systems and IoT.', '@ibrahimali_sfu', NULL, 1, TRUE),
  ('chloe.tremblay@sfu.ca',   'Chloe Tremblay',     'Engineering',           'Year 3', 'Systems engineering student. Co-op at BC Hydro. Love sustainable energy.', '@chloetremblay', 'chloe-tremblay-eng', 1, TRUE),
  ('raj.patel@sfu.ca',        'Raj Patel',          'Engineering',           'Year 1', 'Electrical engineering. Math nerd who also loves music production.', '@rajpatel_sfu', NULL, 1, TRUE),
  ('emily.wu@sfu.ca',         'Emily Wu',           'Engineering',           'Year 3', 'Software systems. Working on a compiler as a personal project.', '@emilywu_sfu', 'emily-wu-swe', 1, TRUE),
  ('hassan.ahmed@sfu.ca',     'Hassan Ahmed',       'Engineering',           'Year 2', 'Biomedical engineering. Interested in medical imaging and machine learning.', '@hassanahmed_sfu', NULL, 1, TRUE),
  ('anna.korolenko@sfu.ca',   'Anna Korolenko',     'Engineering',           'Year 4', 'Mechatronics. TA for ENSC 215. Graduating in spring and job hunting.', '@annakorolenko', 'anna-korolenko-eng', 1, TRUE),

  -- Psychology (5)
  ('maya.johnson@sfu.ca',     'Maya Johnson',       'Psychology',            'Year 3', 'Clinical psych track. Volunteer at the SFU counselling centre. Big mental health advocate.', '@mayajohnson_sfu', NULL, 1, TRUE),
  ('luca.ferrari@sfu.ca',     'Luca Ferrari',       'Psychology',            'Year 2', 'Interested in cognitive psychology and neuroscience. Love reading research papers.', '@lucaferrari', 'luca-ferrari-psyc', 1, TRUE),
  ('grace.okonkwo@sfu.ca',    'Grace Okonkwo',      'Psychology',            'Year 4', 'Writing my honours thesis on cross-cultural differences in emotion regulation.', '@graceokonkwo', 'grace-okonkwo-sfu', 1, TRUE),
  ('ben.larsson@sfu.ca',      'Ben Larsson',        'Psychology',            'Year 1', 'Psych and criminology double major. Want to work in forensic psychology.', '@benlarsson_sfu', NULL, 1, TRUE),
  ('zara.malik@sfu.ca',       'Zara Malik',         'Psychology',            'Year 3', 'Social psych researcher. Running a study on social media and self-esteem.', '@zaramalik', NULL, 1, TRUE),

  -- Communication (4)
  ('tara.williams@sfu.ca',    'Tara Williams',      'Communication',         'Year 2', 'Aspiring journalist. Editor at The Peak student newspaper. Love long-form writing.', '@tarawrites', NULL, 1, TRUE),
  ('julian.santos@sfu.ca',    'Julian Santos',      'Communication',         'Year 3', 'Digital media and PR. Running social media for a few local businesses.', '@juliansantos_sfu', 'julian-santos-comm', 1, TRUE),
  ('elle.dubois@sfu.ca',      'Elle Dubois',        'Communication',         'Year 4', 'Grad school bound. Interested in communication policy and media regulation.', '@elledubois', 'elle-dubois-comm', 1, TRUE),
  ('kai.tanaka@sfu.ca',       'Kai Tanaka',         'Communication',         'Year 2', 'Media studies and film. Part of the SFU Film Club. Aspiring director.', '@kaitanaka_film', NULL, 1, TRUE),

  -- Math & Physics (4)
  ('sasha.ivanova@sfu.ca',    'Sasha Ivanova',      'Mathematics',           'Year 3', 'Pure math student. Loves abstract algebra and topology. Also a competitive chess player.', '@sasha_math', 'sasha-ivanova-math', 1, TRUE),
  ('ethan.brooks@sfu.ca',     'Ethan Brooks',       'Physics',               'Year 2', 'Astrophysics track. Spending nights at the SFU Observatory. Wants to work at NASA.', '@ethanbrooks_phys', NULL, 1, TRUE),
  ('ling.xu@sfu.ca',          'Ling Xu',            'Mathematics',           'Year 4', 'Applied math. Stats and probability. Working as a data science intern.', '@lingxu_sfu', 'ling-xu-data', 1, TRUE),
  ('david.novak@sfu.ca',      'David Novak',        'Physics',               'Year 1', 'Freshman physics student. Fascinated by quantum mechanics. Still recovering from PHYS 120.', '@davidnovak_sfu', NULL, 1, TRUE),

  -- IAT (Interactive Arts & Technology) (3)
  ('maya.chen@sfu.ca',        'Maya Chen',          'Interactive Arts & Technology', 'Year 3', 'UX designer in training. Obsessed with accessible design and user research.', '@mayachen_ux', 'maya-chen-ux', 1, TRUE),
  ('oscar.flores@sfu.ca',     'Oscar Flores',       'Interactive Arts & Technology', 'Year 2', 'Game design and interactive media. Building a mobile game as a side project.', '@oscarflores_iat', NULL, 1, TRUE),
  ('lily.nguyen@sfu.ca',      'Lily Nguyen',        'Interactive Arts & Technology', 'Year 4', 'Portfolio: web design, motion graphics, and brand identity. Freelancing on the side.', '@lilynguyen_design', 'lily-nguyen-design', 1, TRUE),

  -- Other majors (9)
  ('marcus.brown@sfu.ca',     'Marcus Brown',       'Kinesiology',           'Year 2', 'Kin student and varsity swimmer. Interested in sports medicine and rehab.', '@marcusbrown_sfu', NULL, 1, TRUE),
  ('ayla.demir@sfu.ca',       'Ayla Demir',         'Political Science',     'Year 3', 'Poli sci and international studies. Passionate about human rights and policy.', '@aylademir_pols', 'ayla-demir-pols', 1, TRUE),
  ('noah.campbell@sfu.ca',    'Noah Campbell',      'Economics',             'Year 3', 'Econ with a minor in stats. Interested in behavioural economics and public policy.', '@noahcampbell_econ', NULL, 1, TRUE),
  ('isabelle.chen@sfu.ca',    'Isabelle Chen',      'Sociology',             'Year 2', 'Studying inequality and urban communities. Volunteer with a local housing nonprofit.', '@isabellechen', NULL, 1, TRUE),
  ('tyler.morris@sfu.ca',     'Tyler Morris',       'Criminology',           'Year 4', 'Graduating criminology student. Interested in restorative justice and policy reform.', '@tylermorris_sfu', 'tyler-morris-crim', 1, TRUE),
  ('diana.lopez@sfu.ca',      'Diana Lopez',        'Health Sciences',       'Year 2', 'Pre-med path. Volunteering at the hospital. Dream is to be a family physician.', '@dianalopez_sfu', NULL, 1, TRUE),
  ('sam.nguyen@sfu.ca',       'Sam Nguyen',         'Geography',             'Year 3', 'Physical geography and GIS. Doing fieldwork on urban green spaces.', '@samnguyen_geo', NULL, 1, TRUE),
  ('rachel.green@sfu.ca',     'Rachel Green',       'English',               'Year 4', 'Lit theory and creative writing. Editor of Liar''s League, SFU''s literary magazine.', '@rachelgreen_writes', NULL, 1, TRUE),
  ('kai.okafor@sfu.ca',       'Kai Okafor',         'Biomedical Physiology', 'Year 3', 'Biomedical physiology. Research assistant in a neuroscience lab.', '@kaiokafor', 'kai-okafor-bio', 1, TRUE)
ON CONFLICT (email) DO NOTHING;

-- ─── Community memberships ─────────────────────────────────────────────────

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'aisha.khan@sfu.ca'        AND c.name = 'Arab Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'fatima.al-sayed@sfu.ca'   AND c.name = 'Arab Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'omar.hassan@sfu.ca'       AND c.name = 'Arab Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'ibrahim.ali@sfu.ca'       AND c.name = 'Arab Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'hassan.ahmed@sfu.ca'      AND c.name = 'Arab Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'sara.tehrani@sfu.ca'      AND c.name = 'Iranian/Persian Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'zara.malik@sfu.ca'        AND c.name = 'South Asian Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'priya.sharma@sfu.ca'      AND c.name = 'South Asian Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'nina.patel@sfu.ca'        AND c.name = 'South Asian Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'raj.patel@sfu.ca'         AND c.name = 'South Asian Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'diana.lopez@sfu.ca'       AND c.name = 'South Asian Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'james.liu@sfu.ca'         AND c.name = 'East Asian Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'mei.zhang@sfu.ca'         AND c.name = 'East Asian Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'kevin.chen@sfu.ca'        AND c.name = 'East Asian Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'yuna.kim@sfu.ca'          AND c.name = 'East Asian Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'maya.chen@sfu.ca'         AND c.name = 'East Asian Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'lily.nguyen@sfu.ca'       AND c.name = 'Southeast Asian Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'alex.nguyen@sfu.ca'       AND c.name = 'Southeast Asian Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'sam.nguyen@sfu.ca'        AND c.name = 'Southeast Asian Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'kai.tanaka@sfu.ca'        AND c.name = 'East Asian Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'daniel.osei@sfu.ca'       AND c.name = 'West African Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'amara.diallo@sfu.ca'      AND c.name = 'West African Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'grace.okonkwo@sfu.ca'     AND c.name = 'West African Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'kai.okafor@sfu.ca'        AND c.name = 'West African Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'maya.johnson@sfu.ca'      AND c.name = 'East African Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'sofia.rodriguez@sfu.ca'   AND c.name = 'Latin American Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'carlos.mendez@sfu.ca'     AND c.name = 'Latin American Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'diana.lopez@sfu.ca'       AND c.name = 'Latin American Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'oscar.flores@sfu.ca'      AND c.name = 'Latin American Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'julian.santos@sfu.ca'     AND c.name = 'Latin American Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'ryan.kowalski@sfu.ca'     AND c.name = 'Polish Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'anna.korolenko@sfu.ca'    AND c.name = 'Ukrainian/Eastern European Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'sasha.ivanova@sfu.ca'     AND c.name = 'Ukrainian/Eastern European Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'david.novak@sfu.ca'       AND c.name = 'Balkan Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'ayla.demir@sfu.ca'        AND c.name = 'Turkish Community'
ON CONFLICT DO NOTHING;

INSERT INTO user_communities (user_id, community_id)
SELECT u.id, c.id FROM users u, communities c
WHERE u.email = 'luca.ferrari@sfu.ca'      AND c.name = 'Balkan Community'
ON CONFLICT DO NOTHING;

-- ─── Enrollments ──────────────────────────────────────────────────────────

-- Aisha Khan (CS Yr3): CMPT 310, CMPT 354, CMPT 376
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'aisha.khan@sfu.ca' AND c.code = 'CMPT 310' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'aisha.khan@sfu.ca' AND c.code = 'CMPT 354' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'aisha.khan@sfu.ca' AND c.code = 'CMPT 376' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Marco Reyes (CS Yr2): CMPT 225, CMPT 276, CMPT 372
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'marco.reyes@sfu.ca' AND c.code = 'CMPT 225' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'marco.reyes@sfu.ca' AND c.code = 'CMPT 276' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'marco.reyes@sfu.ca' AND c.code = 'CMPT 372' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Sara Tehrani (CS Yr4): CMPT 431, CMPT 474, CMPT 376
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'sara.tehrani@sfu.ca' AND c.code = 'CMPT 431' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'sara.tehrani@sfu.ca' AND c.code = 'CMPT 474' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'sara.tehrani@sfu.ca' AND c.code = 'CMPT 376' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- James Liu (CS Yr1): CMPT 120, MATH 151
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'james.liu@sfu.ca' AND c.code = 'CMPT 120' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'james.liu@sfu.ca' AND c.code = 'MATH 151' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Priya Sharma (CS Yr3): CMPT 225, CMPT 310, CMPT 354
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'priya.sharma@sfu.ca' AND c.code = 'CMPT 225' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'priya.sharma@sfu.ca' AND c.code = 'CMPT 310' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'priya.sharma@sfu.ca' AND c.code = 'CMPT 354' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Daniel Osei (CS Yr2): CMPT 276, CMPT 372, MATH 152
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'daniel.osei@sfu.ca' AND c.code = 'CMPT 276' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'daniel.osei@sfu.ca' AND c.code = 'CMPT 372' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'daniel.osei@sfu.ca' AND c.code = 'MATH 152' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Fatima Al-Sayed (CS Yr4): CMPT 431, CMPT 474, CMPT 310
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'fatima.al-sayed@sfu.ca' AND c.code = 'CMPT 431' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'fatima.al-sayed@sfu.ca' AND c.code = 'CMPT 474' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'fatima.al-sayed@sfu.ca' AND c.code = 'CMPT 310' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Lucas Martin (CS Yr2): CMPT 225, CMPT 276, MATH 152
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'lucas.martin@sfu.ca' AND c.code = 'CMPT 225' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'lucas.martin@sfu.ca' AND c.code = 'CMPT 276' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Mei Zhang (CS Yr3): CMPT 310, CMPT 354, CMPT 376
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'mei.zhang@sfu.ca' AND c.code = 'CMPT 310' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'mei.zhang@sfu.ca' AND c.code = 'CMPT 354' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'mei.zhang@sfu.ca' AND c.code = 'CMPT 376' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Omar Hassan (CS Yr1): CMPT 120, CMPT 225, MATH 151
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'omar.hassan@sfu.ca' AND c.code = 'CMPT 120' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'omar.hassan@sfu.ca' AND c.code = 'CMPT 225' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Jessica Park (Business Yr3): BUS 360, BUS 380, CMNS 253
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'jessica.park@sfu.ca' AND c.code = 'BUS 360' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'jessica.park@sfu.ca' AND c.code = 'BUS 380' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'jessica.park@sfu.ca' AND c.code = 'CMNS 253' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Alex Nguyen (Business Yr2): BUS 207, BUS 237, BUS 254
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'alex.nguyen@sfu.ca' AND c.code = 'BUS 207' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'alex.nguyen@sfu.ca' AND c.code = 'BUS 237' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'alex.nguyen@sfu.ca' AND c.code = 'BUS 254' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Sofia Rodriguez (Business Yr4): BUS 478, BUS 360, CMNS 110
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'sofia.rodriguez@sfu.ca' AND c.code = 'BUS 478' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'sofia.rodriguez@sfu.ca' AND c.code = 'BUS 360' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Kevin Chen (Business Yr2): BUS 207, BUS 254, BUS 237
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'kevin.chen@sfu.ca' AND c.code = 'BUS 207' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'kevin.chen@sfu.ca' AND c.code = 'BUS 254' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'kevin.chen@sfu.ca' AND c.code = 'BUS 237' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Amara Diallo (Business Yr3): BUS 360, BUS 380, BUS 478
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'amara.diallo@sfu.ca' AND c.code = 'BUS 360' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'amara.diallo@sfu.ca' AND c.code = 'BUS 380' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Nina Patel (Business Yr4): BUS 478, BUS 360
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'nina.patel@sfu.ca' AND c.code = 'BUS 478' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'nina.patel@sfu.ca' AND c.code = 'BUS 360' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Carlos Mendez (Business Yr3): BUS 360, BUS 380, CMNS 110
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'carlos.mendez@sfu.ca' AND c.code = 'BUS 360' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'carlos.mendez@sfu.ca' AND c.code = 'CMNS 110' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Yuna Kim (Engineering Yr4): ENSC 380, ENSC 450, MATH 251
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'yuna.kim@sfu.ca' AND c.code = 'ENSC 380' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'yuna.kim@sfu.ca' AND c.code = 'ENSC 450' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Ibrahim Ali (Engineering Yr2): ENSC 215, MATH 152, CMPT 120
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'ibrahim.ali@sfu.ca' AND c.code = 'ENSC 215' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'ibrahim.ali@sfu.ca' AND c.code = 'MATH 152' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Chloe Tremblay (Engineering Yr3): ENSC 320, ENSC 380, MATH 251
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'chloe.tremblay@sfu.ca' AND c.code = 'ENSC 320' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'chloe.tremblay@sfu.ca' AND c.code = 'ENSC 380' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'chloe.tremblay@sfu.ca' AND c.code = 'MATH 251' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Raj Patel (Engineering Yr1): ENSC 215, MATH 151, PHYS 120
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'raj.patel@sfu.ca' AND c.code = 'ENSC 215' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'raj.patel@sfu.ca' AND c.code = 'MATH 151' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'raj.patel@sfu.ca' AND c.code = 'PHYS 120' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Emily Wu (Engineering Yr3): ENSC 320, CMPT 354, CMPT 276
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'emily.wu@sfu.ca' AND c.code = 'ENSC 320' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'emily.wu@sfu.ca' AND c.code = 'CMPT 354' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'emily.wu@sfu.ca' AND c.code = 'CMPT 276' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Hassan Ahmed (Engineering Yr2): ENSC 215, ENSC 320, MATH 152
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'hassan.ahmed@sfu.ca' AND c.code = 'ENSC 215' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'hassan.ahmed@sfu.ca' AND c.code = 'ENSC 320' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Anna Korolenko (Engineering Yr4): ENSC 380, ENSC 450
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'anna.korolenko@sfu.ca' AND c.code = 'ENSC 380' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'anna.korolenko@sfu.ca' AND c.code = 'ENSC 450' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Maya Johnson (Psychology Yr3): PSYC 201, PSYC 362, CMNS 110
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'maya.johnson@sfu.ca' AND c.code = 'PSYC 201' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'maya.johnson@sfu.ca' AND c.code = 'PSYC 362' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Luca Ferrari (Psychology Yr2): PSYC 100, PSYC 201
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'luca.ferrari@sfu.ca' AND c.code = 'PSYC 100' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'luca.ferrari@sfu.ca' AND c.code = 'PSYC 201' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Grace Okonkwo (Psychology Yr4): PSYC 362, PSYC 201, CMNS 253
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'grace.okonkwo@sfu.ca' AND c.code = 'PSYC 362' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'grace.okonkwo@sfu.ca' AND c.code = 'CMNS 253' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Ben Larsson (Psychology Yr1): PSYC 100, CMNS 110
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'ben.larsson@sfu.ca' AND c.code = 'PSYC 100' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Zara Malik (Psychology Yr3): PSYC 201, PSYC 362
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'zara.malik@sfu.ca' AND c.code = 'PSYC 201' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'zara.malik@sfu.ca' AND c.code = 'PSYC 362' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Tara Williams (Comm Yr2): CMNS 110, CMNS 253
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'tara.williams@sfu.ca' AND c.code = 'CMNS 110' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'tara.williams@sfu.ca' AND c.code = 'CMNS 253' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Julian Santos (Comm Yr3): CMNS 110, CMNS 253, BUS 360
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'julian.santos@sfu.ca' AND c.code = 'CMNS 110' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'julian.santos@sfu.ca' AND c.code = 'CMNS 253' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Elle Dubois (Comm Yr4): CMNS 253, CMNS 110
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'elle.dubois@sfu.ca' AND c.code = 'CMNS 253' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Kai Tanaka (Comm Yr2): CMNS 110, IAT 339
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'kai.tanaka@sfu.ca' AND c.code = 'CMNS 110' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'kai.tanaka@sfu.ca' AND c.code = 'IAT 339' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Sasha Ivanova (Math Yr3): MATH 251, CMPT 354
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'sasha.ivanova@sfu.ca' AND c.code = 'MATH 251' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'sasha.ivanova@sfu.ca' AND c.code = 'CMPT 354' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Ethan Brooks (Physics Yr2): PHYS 120, MATH 152
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'ethan.brooks@sfu.ca' AND c.code = 'PHYS 120' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'ethan.brooks@sfu.ca' AND c.code = 'MATH 152' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Ling Xu (Math Yr4): MATH 251, BUS 380
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'ling.xu@sfu.ca' AND c.code = 'MATH 251' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'ling.xu@sfu.ca' AND c.code = 'BUS 380' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- David Novak (Physics Yr1): PHYS 120, MATH 151
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'david.novak@sfu.ca' AND c.code = 'PHYS 120' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'david.novak@sfu.ca' AND c.code = 'MATH 151' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Maya Chen (IAT Yr3): IAT 339, CMNS 253, CMPT 372
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'maya.chen@sfu.ca' AND c.code = 'IAT 339' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'maya.chen@sfu.ca' AND c.code = 'CMNS 253' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Oscar Flores (IAT Yr2): IAT 339, CMPT 276
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'oscar.flores@sfu.ca' AND c.code = 'IAT 339' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Lily Nguyen (IAT Yr4): IAT 339, CMNS 253
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'lily.nguyen@sfu.ca' AND c.code = 'IAT 339' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'lily.nguyen@sfu.ca' AND c.code = 'CMNS 253' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Noah Campbell (Economics Yr3): BUS 207, BUS 380, MATH 251
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'noah.campbell@sfu.ca' AND c.code = 'BUS 207' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'noah.campbell@sfu.ca' AND c.code = 'BUS 380' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Ayla Demir (Poli Sci Yr3): CMNS 110, CMNS 253
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'ayla.demir@sfu.ca' AND c.code = 'CMNS 110' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- Kai Okafor (Biomed Physiology Yr3): PSYC 201, PHYS 120
INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'kai.okafor@sfu.ca' AND c.code = 'PSYC 201' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

INSERT INTO enrollments (user_id, course_id)
SELECT u.id, c.id FROM users u, courses c
WHERE u.email = 'kai.okafor@sfu.ca' AND c.code = 'PHYS 120' AND c.term = 'Spring 2025'
ON CONFLICT DO NOTHING;

-- ─── Multi-tenant: scope communities per university ─────────────────────────

-- Step 1: add university_id to communities
ALTER TABLE communities ADD COLUMN IF NOT EXISTS university_id INTEGER REFERENCES universities(id);

-- Step 2: backfill all existing communities to SFU
UPDATE communities
SET university_id = (SELECT id FROM universities WHERE email_domain = 'sfu.ca' LIMIT 1)
WHERE university_id IS NULL;

-- Step 3: replace the global-name unique constraint with a per-university one
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'communities_name_unique') THEN
    ALTER TABLE communities DROP CONSTRAINT communities_name_unique;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'communities_name_uni_unique') THEN
    ALTER TABLE communities ADD CONSTRAINT communities_name_uni_unique UNIQUE (name, university_id);
  END IF;
END $$;

-- Step 4: index for fast university-scoped community lookups
CREATE INDEX IF NOT EXISTS idx_communities_university ON communities(university_id);

-- Step 5: index for visitor queries
CREATE INDEX IF NOT EXISTS idx_profile_visits_visitor ON profile_visits(visitor_id, visited_at DESC);

-- ─── Communities: seed UBC, Queen's, McGill ──────────────────────────────────
-- Same 16 cultural communities as SFU, each tied to the correct university_id.

INSERT INTO communities (name, region, flag_emoji, color_hex, university_id)
SELECT c.name, c.region, c.flag_emoji, c.color_hex, u.id
FROM (VALUES
  ('Arab Community',                       'Middle East', '🌙', '#c8a84b'),
  ('Iranian/Persian Community',            'Middle East', '🇮🇷', '#c41e3a'),
  ('Turkish Community',                    'Middle East', '🇹🇷', '#e30a17'),
  ('Balkan Community',                     'Europe',      '⚓',  '#003087'),
  ('Polish Community',                     'Europe',      '🇵🇱', '#dc143c'),
  ('Ukrainian/Eastern European Community', 'Europe',      '🇺🇦', '#005bbb'),
  ('East Asian Community',                 'Asia',        '🏮', '#de2910'),
  ('South Asian Community',                'Asia',        '🌺', '#ff9933'),
  ('Southeast Asian Community',            'Asia',        '🌴', '#009b77'),
  ('Filipino Community',                   'Asia',        '🇵🇭', '#0038a8'),
  ('East African Community',               'Africa',      '🦁', '#078930'),
  ('North African Community',              'Africa',      '🌅', '#c09300'),
  ('Sub-Saharan African Community',        'Africa',      '🥁', '#cc0001'),
  ('West African Community',               'Africa',      '🌍', '#006b3f'),
  ('Latin American Community',             'Americas',    '🌶', '#cf142b'),
  ('Indigenous Community',                 'Americas',    '🪶', '#8b4513')
) AS c(name, region, flag_emoji, color_hex)
CROSS JOIN (SELECT id FROM universities WHERE email_domain IN ('ubc.ca', 'mcgill.ca', 'queensu.ca')) u
ON CONFLICT (name, university_id) DO NOTHING;

-- ─── Departments: seed per-university faculty lists ───────────────────────────

-- UBC faculties (from ubc.ca)
INSERT INTO departments (name, university_id)
SELECT d.name, u.id FROM (VALUES
  ('Faculty of Applied Science'),
  ('School of Architecture and Landscape Architecture'),
  ('Faculty of Arts'),
  ('School of Audiology and Speech Sciences'),
  ('Sauder School of Business'),
  ('School of Community and Regional Planning'),
  ('Faculty of Dentistry'),
  ('Faculty of Education'),
  ('Extended Learning'),
  ('Faculty of Forestry & Environmental Stewardship'),
  ('Graduate and Postdoctoral Studies'),
  ('School of Information'),
  ('School of Journalism, Writing, and Media'),
  ('School of Kinesiology'),
  ('Faculty of Land and Food Systems'),
  ('Peter A. Allard School of Law'),
  ('Faculty of Medicine'),
  ('School of Music'),
  ('School of Nursing'),
  ('Faculty of Pharmaceutical Sciences'),
  ('School of Population and Public Health'),
  ('School of Public Policy and Global Affairs'),
  ('Faculty of Science'),
  ('School of Social Work'),
  ('UBC Vantage College'),
  ('Vancouver School of Economics')
) AS d(name)
CROSS JOIN (SELECT id FROM universities WHERE email_domain = 'ubc.ca') u
ON CONFLICT (name, university_id) DO NOTHING;

-- McGill faculties (from mcgill.ca)
INSERT INTO departments (name, university_id)
SELECT d.name, u.id FROM (VALUES
  ('Faculty of Agricultural and Environmental Sciences'),
  ('Faculty of Arts'),
  ('Faculty of Dental Medicine and Oral Health Sciences'),
  ('Faculty of Education'),
  ('Faculty of Engineering'),
  ('Graduate and Postdoctoral Studies'),
  ('Faculty of Law'),
  ('Desautels Faculty of Management'),
  ('Faculty of Medicine and Health Sciences'),
  ('Schulich School of Music'),
  ('Faculty of Science'),
  ('School of Continuing Studies')
) AS d(name)
CROSS JOIN (SELECT id FROM universities WHERE email_domain = 'mcgill.ca') u
ON CONFLICT (name, university_id) DO NOTHING;

-- Queen's faculties (from queensu.ca)
INSERT INTO departments (name, university_id)
SELECT d.name, u.id FROM (VALUES
  ('Faculty of Arts and Science'),
  ('Smith School of Engineering and Applied Science'),
  ('Smith School of Business'),
  ('Faculty of Health Sciences'),
  ('Faculty of Education'),
  ('Faculty of Law'),
  ('School of Graduate Studies and Postdoctoral Affairs')
) AS d(name)
CROSS JOIN (SELECT id FROM universities WHERE email_domain = 'queensu.ca') u
ON CONFLICT (name, university_id) DO NOTHING;

-- SFU: replace the generic auto-seeded faculties with the correct SFU ones.
-- Only inserts if not already present; does not delete existing rows.
INSERT INTO departments (name, university_id)
SELECT d.name, u.id FROM (VALUES
  ('Faculty of Applied Sciences'),
  ('Faculty of Arts and Social Sciences'),
  ('Beedie School of Business'),
  ('Faculty of Communication, Art and Technology'),
  ('Faculty of Education'),
  ('Faculty of Environment'),
  ('Faculty of Graduate Studies'),
  ('Faculty of Health Sciences'),
  ('Faculty of Science'),
  ('School of Medicine')
) AS d(name)
CROSS JOIN (SELECT id FROM universities WHERE email_domain = 'sfu.ca') u
ON CONFLICT (name, university_id) DO NOTHING;

-- ─── Remove wrongly-seeded SFU faculties from non-SFU universities ────────────
-- The auto-seed fallback in professors.js previously applied SFU faculties to all
-- universities. Delete those incorrect entries from UBC, McGill, and Queen's so the
-- correct per-university faculties (seeded above) are the only ones that remain.
-- Safe to run repeatedly: DELETE WHERE ... IN (...) is a no-op if already clean.
DELETE FROM departments
WHERE university_id IN (SELECT id FROM universities WHERE email_domain IN ('ubc.ca', 'mcgill.ca', 'queensu.ca'))
  AND name IN (
    'Faculty of Applied Sciences',
    'Faculty of Arts and Social Sciences',
    'Beedie School of Business',
    'Faculty of Communication, Art and Technology',
    'Faculty of Environment',
    'Faculty of Graduate Studies',
    'Faculty of Health Sciences',
    'School of Medicine'
  );
