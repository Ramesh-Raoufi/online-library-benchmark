CREATE DATABASE IF NOT EXISTS library_benchmark CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE DATABASE IF NOT EXISTS library_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
GRANT ALL PRIVILEGES ON library_benchmark.* TO 'library'@'%';
GRANT ALL PRIVILEGES ON library_test.* TO 'library'@'%';
