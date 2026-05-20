-- Attention Auditor — run once on Railway MySQL (Query tab or mysql client).
-- This does NOT speed up pip/build; it prevents missing-table errors and helps query speed.

CREATE DATABASE IF NOT EXISTS attention_auditor
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE attention_auditor;

-- Raw events from extension sync (append-only; grows over time)
CREATE TABLE IF NOT EXISTS browsing_data (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    client_token VARCHAR(36) NOT NULL,
    domain VARCHAR(255) NOT NULL,
    seconds_spent INT NOT NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_client_recorded (client_token, recorded_at),
    INDEX idx_client_domain_recorded (client_token, domain, recorded_at)
) ENGINE=InnoDB;

-- Per-day totals (dashboard reads this heavily)
CREATE TABLE IF NOT EXISTS daily_summary (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    client_token VARCHAR(36) NOT NULL,
    domain VARCHAR(255) NOT NULL,
    total_seconds INT NOT NULL DEFAULT 0,
    visit_date DATE NOT NULL,
    UNIQUE KEY uq_client_domain_day (client_token, domain, visit_date),
    INDEX idx_client_visit (client_token, visit_date),
    INDEX idx_client_visit_domain (client_token, visit_date, domain)
) ENGINE=InnoDB;

-- Per-user domain labels
CREATE TABLE IF NOT EXISTS site_categories (
    client_token VARCHAR(36) NOT NULL,
    domain VARCHAR(255) NOT NULL,
    category ENUM('productive', 'distracting', 'neutral') NOT NULL,
    source ENUM('default', 'ai', 'user') NOT NULL DEFAULT 'default',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (client_token, domain),
    INDEX idx_domain (domain)
) ENGINE=InnoDB;

-- Used when RATE_LIMIT_STORAGE=mysql (default in app.py) — create up front so
-- the first /api/track after deploy does not run CREATE TABLE on a cold DB.
CREATE TABLE IF NOT EXISTS rate_limits (
    bucket_key VARCHAR(255) NOT NULL PRIMARY KEY,
    window_id BIGINT NOT NULL,
    count INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_window_id (window_id)
) ENGINE=InnoDB;
