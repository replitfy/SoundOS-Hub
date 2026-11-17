-- Values used by the historical import must follow the same vocabulary as the
-- operational Education screens.
UPDATE classes SET status = 'Planejada' WHERE status = 'scheduled';
UPDATE classes SET status = 'Encerrada' WHERE status = 'completed';
UPDATE enrollments SET payment_status = 'pending' WHERE payment_status = 'unknown';
UPDATE enrollments SET contract_status = 'pending' WHERE contract_status = 'sent';
UPDATE enrollments SET contract_status = 'Assinado' WHERE contract_status = 'returned';