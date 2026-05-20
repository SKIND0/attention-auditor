-- PASTE THIS ENTIRE FILE into Railway → MySQL service → Database → Data tab
-- (the box that says SELECT * FROM browsing_data). Delete that line first.
-- Then click Run / Execute (lightning icon) or press Ctrl+Enter.
--
-- Do NOT use CREATE DATABASE or USE — Railway already picked the DB (usually "railway").

CREATE TABLE IF NOT EXISTS browsing_data (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    client_token VARCHAR(36) NOT NULL,
    domain VARCHAR(255) NOT NULL,
    seconds_spent INT NOT NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_client_recorded (client_token, recorded_at),
    INDEX idx_client_domain_recorded (client_token, domain, recorded_at)
);

CREATE TABLE IF NOT EXISTS daily_summary (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    client_token VARCHAR(36) NOT NULL,
    domain VARCHAR(255) NOT NULL,
    total_seconds INT NOT NULL DEFAULT 0,
    visit_date DATE NOT NULL,
    UNIQUE KEY uq_client_domain_day (client_token, domain, visit_date),
    INDEX idx_client_visit (client_token, visit_date),
    INDEX idx_client_visit_domain (client_token, visit_date, domain)
);

CREATE TABLE IF NOT EXISTS site_categories (
    client_token VARCHAR(36) NOT NULL,
    domain VARCHAR(255) NOT NULL,
    category ENUM('productive', 'distracting', 'neutral') NOT NULL,
    source ENUM('default', 'ai', 'user') NOT NULL DEFAULT 'default',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (client_token, domain),
    INDEX idx_domain (domain)
);

CREATE TABLE IF NOT EXISTS rate_limits (
    bucket_key VARCHAR(255) NOT NULL PRIMARY KEY,
    window_id BIGINT NOT NULL,
    count INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_window_id (window_id)
);
