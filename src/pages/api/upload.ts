import { ImageFormat, InvisibleImage } from '@prisma/client';
import { randomUUID } from 'crypto';
import dayjs from 'dayjs';
import { readdir, readFile, unlink, writeFile } from 'fs/promises';
import zconfig from 'lib/config';
import datasource from 'lib/datasource';
import { sendUpload } from 'lib/discord';
import Logger from 'lib/logger';
import { NextApiReq, NextApiRes, withZipline } from 'lib/middleware/withZipline';
import prisma from 'lib/prisma';
import { createInvisImage, hashPassword, randomChars } from 'lib/util';
import { parseExpiry } from 'lib/utils/client';
import multer from 'multer';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';

const uploader = multer();

async function handler(req: NextApiReq, res: NextApiRes) {
  if (req.method !== 'POST') return res.forbid('invalid method');
  if (!req.headers.authorization) return res.forbid('no authorization');

  const user = await prisma.user.findFirst({
    where: {
      token: req.headers.authorization,
    },
  });

  if (!user) return res.forbid('authorization incorrect');

  await run(uploader.array('file'))(req, res);

  const response: { files: string[]; expires_at?: Date } = { files: [] };
  const expires_at = req.headers['expires-at'] as string;
  let expiry: Date;

  if (expires_at) {
    expiry = parseExpiry(expires_at);
    if (!expiry) return res.error('invalid date');
    else {
      response.expires_at = expiry;
    }
  }

  const rawFormat = ((req.headers.format || '') as string).toUpperCase() || 'RANDOM';
  const format: ImageFormat = Object.keys(ImageFormat).includes(rawFormat) && ImageFormat[rawFormat];

  const imageCompressionPercent = req.headers['image-compression-percent']
    ? Number(req.headers['image-compression-percent'])
    : null;
  if (isNaN(imageCompressionPercent)) return res.error('invalid image compression percent (invalid number)');
  if (imageCompressionPercent < 0 || imageCompressionPercent > 100)
    return res.error('invalid image compression percent (% < 0 || % > 100)');

  const fileMaxViews = req.headers['max-views'] ? Number(req.headers['max-views']) : null;
  if (isNaN(fileMaxViews)) return res.error('invalid max views (invalid number)');
  if (fileMaxViews < 0) return res.error('invalid max views (max views < 0)');

  // handle partial uploads before ratelimits
  if (req.headers['content-range']) {
    // parses content-range header (bytes start-end/total)
    const [start, end, total] = req.headers['content-range']
      .replace('bytes ', '')
      .replace('-', '/')
      .split('/')
      .map((x) => Number(x));

    const filename = req.headers['x-zipline-partial-filename'] as string;
    const mimetype = req.headers['x-zipline-partial-mimetype'] as string;
    const identifier = req.headers['x-zipline-partial-identifier'];
    const lastchunk = req.headers['x-zipline-partial-lastchunk'] === 'true';

    const tempFile = join(tmpdir(), `zipline_partial_${identifier}_${start}_${end}`);
    await writeFile(tempFile, req.files[0].buffer);

    if (lastchunk) {
      const partials = await readdir(tmpdir()).then((files) =>
        files.filter((x) => x.startsWith(`zipline_partial_${identifier}`))
      );

      const readChunks = partials.map((x) => {
        const [, , , start, end] = x.split('_');
        return { start: Number(start), end: Number(end), filename: x };
      });

      // combine chunks
      const chunks = new Uint8Array(total);

      for (let i = 0; i !== readChunks.length; ++i) {
        const chunkData = readChunks[i];

        const buffer = await readFile(join(tmpdir(), chunkData.filename));
        await unlink(join(tmpdir(), readChunks[i].filename));

        chunks.set(buffer, chunkData.start);
      }

      const ext = filename.split('.').pop();
      if (zconfig.uploader.disabled_extensions.includes(ext))
        return res.error('disabled extension recieved: ' + ext);
      let fileName: string;

      switch (format) {
        case ImageFormat.RANDOM:
          fileName = randomChars(zconfig.uploader.length);
          break;
        case ImageFormat.DATE:
          fileName = dayjs().format(zconfig.uploader.format_date);
          break;
        case ImageFormat.UUID:
          fileName = randomUUID({ disableEntropyCache: true });
          break;
        case ImageFormat.NAME:
          fileName = filename.split('.')[0];
          break;
        default:
          fileName = randomChars(zconfig.uploader.length);
          break;
      }

      let password = null;
      if (req.headers.password) {
        password = await hashPassword(req.headers.password as string);
      }

      const compressionUsed = imageCompressionPercent && mimetype.startsWith('image/');
      let invis: InvisibleImage;

      const file = await prisma.image.create({
        data: {
          file: `${fileName}.${compressionUsed ? 'jpg' : ext}`,
          mimetype,
          userId: user.id,
          embed: !!req.headers.embed,
          format,
          password,
          expires_at: expiry,
          maxViews: fileMaxViews,
        },
      });

      if (req.headers.zws) invis = await createInvisImage(zconfig.uploader.length, file.id);

      await datasource.save(file.file, Buffer.from(chunks));

      return res.json({
        files: [
          `${zconfig.core.https ? 'https' : 'http'}://${req.headers.host}${
            zconfig.uploader.route === '/' ? '' : zconfig.uploader.route
          }/${invis ? invis.invis : file.file}`,
        ],
      });
    }

    return res.json({
      success: true,
    });
  }

  if (user.ratelimit) {
    const remaining = user.ratelimit.getTime() - Date.now();
    if (remaining <= 0) {
      await prisma.user.update({
        where: {
          id: user.id,
        },
        data: {
          ratelimit: null,
        },
      });
    } else {
      return res.ratelimited(remaining);
    }
  }

  if (!req.files) return res.error('no files');
  if (req.files && req.files.length === 0) return res.error('no files');

  for (let i = 0; i !== req.files.length; ++i) {
    const file = req.files[i];
    if (file.size > zconfig.uploader[user.administrator ? 'admin_limit' : 'user_limit'])
      return res.error(`file[${i}]: size too big`);

    const ext = file.originalname.split('.').pop();
    if (zconfig.uploader.disabled_extensions.includes(ext))
      return res.error(`file[${i}]: disabled extension recieved: ${ext}`);
    let fileName: string;

    switch (format) {
      case ImageFormat.RANDOM:
        fileName = randomChars(zconfig.uploader.length);
        break;
      case ImageFormat.DATE:
        fileName = dayjs().format(zconfig.uploader.format_date);
        break;
      case ImageFormat.UUID:
        fileName = randomUUID({ disableEntropyCache: true });
        break;
      case ImageFormat.NAME:
        fileName = file.originalname.split('.')[0];
        break;
      default:
        fileName = randomChars(zconfig.uploader.length);
        break;
    }

    let password = null;
    if (req.headers.password) {
      password = await hashPassword(req.headers.password as string);
    }

    const compressionUsed = imageCompressionPercent && file.mimetype.startsWith('image/');
    let invis: InvisibleImage;
    const image = await prisma.image.create({
      data: {
        file: `${fileName}.${compressionUsed ? 'jpg' : ext}`,
        mimetype: req.headers.uploadtext ? 'text/plain' : compressionUsed ? 'image/jpeg' : file.mimetype,
        userId: user.id,
        embed: !!req.headers.embed,
        format,
        password,
        expires_at: expiry,
        maxViews: fileMaxViews,
      },
    });

    if (req.headers.zws) invis = await createInvisImage(zconfig.uploader.length, image.id);

    if (compressionUsed) {
      const buffer = await sharp(file.buffer).jpeg({ quality: imageCompressionPercent }).toBuffer();
      await datasource.save(image.file, buffer);
      Logger.get('file').info(
        `User ${user.username} (${user.id}) compressed image from ${file.buffer.length} -> ${buffer.length} bytes`
      );
    } else {
      await datasource.save(image.file, file.buffer);
    }

    Logger.get('file').info(
      `User ${user.username} (${user.id}) uploaded an file ${image.file} (${image.id})`
    );
    if (user.domains.length) {
      const domain = user.domains[Math.floor(Math.random() * user.domains.length)];
      response.files.push(
        `${domain}${zconfig.uploader.route === '/' ? '' : zconfig.uploader.route}/${
          invis ? invis.invis : image.file
        }`
      );
    } else {
      response.files.push(
        `${zconfig.core.https ? 'https' : 'http'}://${req.headers.host}${
          zconfig.uploader.route === '/' ? '' : zconfig.uploader.route
        }/${invis ? invis.invis : image.file}`
      );
    }

    if (zconfig.discord?.upload) {
      await sendUpload(
        user,
        image,
        `${zconfig.core.https ? 'https' : 'http'}://${req.headers.host}/r/${invis ? invis.invis : image.file}`
      );
    }
  }

  if (user.administrator && zconfig.ratelimit.admin > 0) {
    await prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        ratelimit: new Date(Date.now() + zconfig.ratelimit.admin * 1000),
      },
    });
  } else if (!user.administrator && zconfig.ratelimit.user > 0) {
    if (user.administrator && zconfig.ratelimit.user > 0) {
      await prisma.user.update({
        where: {
          id: user.id,
        },
        data: {
          ratelimit: new Date(Date.now() + zconfig.ratelimit.user * 1000),
        },
      });
    }
  }

  return res.json(response);
}

function run(middleware: any) {
  return (req, res) =>
    new Promise((resolve, reject) => {
      middleware(req, res, (result) => {
        if (result instanceof Error) reject(result);
        resolve(result);
      });
    });
}

export default async function handlers(req, res) {
  return withZipline(handler)(req, res);
}

export const config = {
  api: {
    bodyParser: false,
  },
};
