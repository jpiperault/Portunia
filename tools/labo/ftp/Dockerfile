# Serveur FTP / FTPS de test (vsftpd), certificat auto-signé, reprise de session TLS exigée.
FROM debian:bookworm-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends vsftpd openssl \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash test \
 && echo 'test:portunia-test' | chpasswd \
 && mkdir -p /etc/ssl/labo /var/run/vsftpd/empty \
 && openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -subj "/CN=ftp.labo.test" \
      -keyout /etc/ssl/labo/ftp.key -out /etc/ssl/labo/ftp.pem \
 && mkdir -p /home/test/depot && echo "Fichier de test du labo Portunia" > /home/test/depot/lisez-moi.txt \
 && chown -R test:test /home/test

COPY vsftpd.conf /etc/vsftpd.conf
EXPOSE 21 30000-30009
CMD ["/usr/sbin/vsftpd", "/etc/vsftpd.conf"]
