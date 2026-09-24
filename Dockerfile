# Single image, two roles:
#   web     -> Apache serving the IDE + API (default command)
#   runtime -> the PLC scan engine:  docker run ... virtualplc run
FROM composer:2 AS deps
WORKDIR /app
COPY composer.json ./
RUN composer install --no-dev --no-interaction --no-progress --prefer-dist --no-scripts --no-autoloader
COPY src ./src
RUN composer dump-autoload --no-dev --classmap-authoritative

FROM php:8.3-apache
RUN docker-php-ext-install pcntl \
 && a2enmod headers \
 && sed -ri 's!/var/www/html!/app/public!g' /etc/apache2/sites-available/*.conf /etc/apache2/apache2.conf \
 && echo 'ServerTokens Prod\nServerSignature Off' > /etc/apache2/conf-enabled/zz-hardening.conf \
 && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"

WORKDIR /app
COPY --from=deps /app/vendor ./vendor
COPY bin ./bin
COPY public ./public
COPY src ./src
COPY examples ./examples
RUN ln -s /app/bin/virtualplc /usr/local/bin/virtualplc \
 && mkdir -p /app/var && chown -R www-data:www-data /app/var

ENV VPLC_DATA_DIR=/app/var
VOLUME ["/app/var"]
EXPOSE 80 5020
